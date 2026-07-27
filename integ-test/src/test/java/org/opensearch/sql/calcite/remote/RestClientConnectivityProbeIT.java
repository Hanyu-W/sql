/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

package org.opensearch.sql.calcite.remote;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import org.apache.hc.core5.http.HttpHost;
import org.apache.hc.core5.util.Timeout;
import org.junit.Test;
import org.opensearch.client.Request;
import org.opensearch.client.Response;
import org.opensearch.client.RestClient;
import org.opensearch.client.RestClientBuilder;
import org.opensearch.test.OpenSearchTestCase;

/**
 * Connectivity probe for {@code tests.rest.cluster}, used to diagnose why the REST test client
 * cannot reach some engine versions that plain HTTP clients reach fine.
 *
 * <p>Context: on the PPL lint multi-version matrix the 2.19.0 observation leg fails with {@code
 * SocketTimeoutException} after the full 60s response timeout, thrown from {@code
 * OpenSearchRestTestCase.initClient} on its {@code GET _nodes/plugins} call — before any test body
 * runs. From the same runner, {@code curl} against the same endpoint on the same address returns
 * HTTP 200 in 0s. The 3.5.0 leg, with byte-identical Gradle args, network topology, publish address
 * and task graph, passes. Seven hypotheses (index-wipe race, Gradle cluster fallback, HTTP/2
 * negotiation, FIPS, plugin set, port collision, address family) have each been refuted by
 * observation.
 *
 * <p>It extends {@link OpenSearchTestCase}, NOT the REST base class. Two constraints meet here:
 * {@code integTestRemote} runs the default JUnit 4 runner (only {@code integJdbcTest} calls {@code
 * useJUnitPlatform()}), and Gradle only discovers an IT that inherits a runner from a framework
 * base class — a standalone class is silently collected as ZERO tests, which is how the first
 * version of this probe "passed" while reporting nothing. {@code OpenSearchTestCase} supplies that
 * runner but builds no REST client, so discovery works without inheriting the hang under
 * investigation. Instead of the framework's client setup, this walks up the stack one layer at a
 * time against the same address, so a single run says exactly which layer stops working:
 *
 * <ol>
 *   <li>raw TCP connect — is the port reachable from this JVM at all?
 *   <li>{@code HttpURLConnection} — does the JDK's own HTTP stack get a response?
 *   <li>{@code RestClient} with default settings — does the OpenSearch async client work?
 *   <li>{@code RestClient} on the endpoints the framework itself calls, timed individually.
 * </ol>
 *
 * <p>Every step is time-bounded and reports rather than asserts, because the point is to collect
 * evidence from a leg that is already failing. The one assertion is that step 1 succeeded: if the
 * JVM cannot open a socket, nothing below it means anything.
 *
 * <p>Run with: {@code ./gradlew :integ-test:integTestRemote --tests
 * '*RestClientConnectivityProbeIT' -Dtests.rest.cluster=localhost:9200}
 */
public class RestClientConnectivityProbeIT extends OpenSearchTestCase {

  /** Bound well below the framework's 60s so a hang is visibly a hang, not a wait. */
  private static final Timeout PROBE_TIMEOUT = Timeout.ofSeconds(15);

  private static final String[] FRAMEWORK_ENDPOINTS = {
    // The exact call OpenSearchRestTestCase.initClient makes, and the one that hangs.
    "_nodes/plugins",
    // What the wipe in OpenSearchSQLRestTestCase.wipeAllOpenSearchIndices calls next.
    "_cat/indices?format=json&expand_wildcards=all",
    // A trivial response, to separate "any request" from "this request".
    "_cluster/health",
    // The PPL endpoint the contract actually needs, so a pass here means the leg could work.
    "_plugins/_ppl/_grammar",
  };

  @Test
  public void probeConnectivity() {
    String cluster = System.getProperty("tests.rest.cluster");
    if (cluster == null || cluster.isEmpty()) {
      log("SKIP: -Dtests.rest.cluster not set");
      return;
    }
    String hostPort = cluster.split(",")[0];
    int sep = hostPort.lastIndexOf(':');
    String host = hostPort.substring(0, sep);
    int port = Integer.parseInt(hostPort.substring(sep + 1));
    log("probing " + host + ":" + port);

    boolean tcpOk = probeRawSocket(host, port);
    probeHttpUrlConnection(host, port);
    probeRestClient(host, port);

    // Only a hard failure here is fatal: without a socket the rest is noise.
    if (!tcpOk) {
      throw new AssertionError("could not open a TCP connection to " + host + ":" + port);
    }
  }

  /** Layer 1: can this JVM open a socket to the published port? */
  private boolean probeRawSocket(String host, int port) {
    long start = System.nanoTime();
    try (Socket socket = new Socket()) {
      socket.connect(new InetSocketAddress(host, port), (int) PROBE_TIMEOUT.toMilliseconds());
      log("tcp connect OK in " + millis(start) + "ms (localAddr=" + socket.getLocalAddress() + ")");
      return true;
    } catch (Exception e) {
      log("tcp connect FAILED after " + millis(start) + "ms: " + describe(e));
      return false;
    }
  }

  /**
   * Layer 2: the JDK's own blocking HTTP stack. If this works while {@code RestClient} does not,
   * the problem is in the async client rather than in the network or the engine.
   */
  private void probeHttpUrlConnection(String host, int port) {
    long start = System.nanoTime();
    try {
      URL url = new URL("http://" + host + ":" + port + "/_nodes/plugins");
      HttpURLConnection connection = (HttpURLConnection) url.openConnection();
      connection.setConnectTimeout((int) PROBE_TIMEOUT.toMilliseconds());
      connection.setReadTimeout((int) PROBE_TIMEOUT.toMilliseconds());
      int status = connection.getResponseCode();
      long bytes = drain(connection);
      log(
          "HttpURLConnection _nodes/plugins OK in "
              + millis(start)
              + "ms: HTTP "
              + status
              + ", "
              + bytes
              + " bytes");
      connection.disconnect();
    } catch (Exception e) {
      log("HttpURLConnection _nodes/plugins FAILED after " + millis(start) + "ms: " + describe(e));
    }
  }

  /**
   * Layer 3: the real {@code RestClient}, built the way the framework builds it (defaults only, no
   * credentials or TLS since these legs are plain HTTP), then each framework endpoint in turn.
   *
   * <p>Timed per endpoint: a uniform failure means the client cannot talk to this engine at all,
   * while one slow endpoint among fast ones means the response itself is the problem.
   */
  private void probeRestClient(String host, int port) {
    RestClientBuilder builder =
        RestClient.builder(new HttpHost("http", host, port))
            .setRequestConfigCallback(
                config -> config.setConnectTimeout(PROBE_TIMEOUT).setResponseTimeout(PROBE_TIMEOUT))
            // The framework sets this too; without it a deprecation warning header can turn into a
            // failure and confuse the diagnosis.
            .setStrictDeprecationMode(false);

    try (RestClient client = builder.build()) {
      for (String endpoint : FRAMEWORK_ENDPOINTS) {
        long start = System.nanoTime();
        try {
          Response response = client.performRequest(new Request("GET", "/" + endpoint));
          long bytes = response.getEntity() == null ? 0 : response.getEntity().getContentLength();
          log(
              "RestClient "
                  + endpoint
                  + " OK in "
                  + millis(start)
                  + "ms: HTTP "
                  + response.getStatusLine().getStatusCode()
                  + ", "
                  + bytes
                  + " bytes");
        } catch (Exception e) {
          log("RestClient " + endpoint + " FAILED after " + millis(start) + "ms: " + describe(e));
        }
      }
    } catch (IOException e) {
      log("RestClient could not be built/closed: " + describe(e));
    }
  }

  private static long drain(HttpURLConnection connection) throws IOException {
    byte[] buffer = new byte[8192];
    long total = 0;
    try (var stream = connection.getInputStream()) {
      int read;
      while ((read = stream.read(buffer)) != -1) {
        total += read;
      }
    }
    return total;
  }

  /** Full cause chain: the outer message alone hides which layer actually gave up. */
  private static String describe(Throwable error) {
    List<String> chain = new ArrayList<>();
    for (Throwable current = error; current != null; current = current.getCause()) {
      chain.add(current.getClass().getSimpleName() + "(" + current.getMessage() + ")");
      if (current.getCause() == current) {
        break;
      }
    }
    return String.join(" <- ", chain);
  }

  private static long millis(long startNanos) {
    return (System.nanoTime() - startNanos) / 1_000_000;
  }

  private static void log(String message) {
    // stdout so it lands in the Gradle test output the CI job already prints.
    System.out.println("[rest-connectivity-probe] " + message);
  }
}
