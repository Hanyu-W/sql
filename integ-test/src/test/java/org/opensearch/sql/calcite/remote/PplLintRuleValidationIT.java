/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

package org.opensearch.sql.calcite.remote;

import static org.opensearch.sql.legacy.TestUtils.getResponseBody;
import static org.opensearch.sql.plugin.rest.RestPPLQueryAction.QUERY_API_ENDPOINT;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.jupiter.api.Test;
import org.opensearch.client.Request;
import org.opensearch.client.RequestOptions;
import org.opensearch.client.Response;
import org.opensearch.client.ResponseException;
import org.opensearch.sql.common.setting.Settings;
import org.opensearch.sql.legacy.TestUtils;
import org.opensearch.sql.ppl.PPLIntegTestCase;

/**
 * Backend half of the schema-v3 PPL lint rule validation contract.
 *
 * <p>This test drives the live {@code POST /_plugins/_ppl} endpoint on the SQL plugin built from
 * the current checkout. For every contract (see {@code
 * src/test/resources/ppl-lint/contracts/*.spec.json}) it selects the single {@code expectations[]}
 * entry that matches the candidate backend version (exactly one must match, or the contract fails
 * before any query runs), applies the contract's cluster settings, and asserts, per query's {@code
 * backend.kind}:
 *
 * <ul>
 *   <li>{@code rejection} — the query returns the contracted HTTP status and structured error body
 *       ({@code status}, {@code error.type}, {@code error.reason});
 *   <li>{@code result-shape} — a 200 response whose {@code datarows} match {@code datarowsNonEmpty}
 *       / {@code datarowsCount} / {@code columnAllNull};
 *   <li>{@code advisory} — a 200 response (soft oracle for rules whose backend behavior can't be
 *       confirmed by a single run, e.g. head nondeterminism, fallback warnings).
 * </ul>
 *
 * <p>The contract files are shared verbatim with the SQL-owned OSD detector runner ({@code
 * scripts/ppl-lint/run-frontend-contract.mjs}) so the same reviewed cases pin both the OSD analyzer
 * diagnostic count and the SQL backend behavior; neither side can drift without a red build. The
 * rejection-body parsing mirrors {@link
 * org.opensearch.sql.calcite.remote.CalciteErrorReportStageIT}; the Calcite setup follows {@link
 * org.opensearch.sql.calcite.remote.CalcitePPLEventstatsIT}.
 *
 * <p>While the ephemeral cluster is alive, the test also exports the candidate runtime grammar
 * bundle it built ({@code GET /_plugins/_ppl/_grammar}) and a small target manifest pairing the
 * bundle with the backend version and grammar hash. These become workflow artifacts that the
 * detector-validation job injects into OSD's headless lint API, so both halves validate against the
 * SAME candidate grammar (design §4.2, §4.3). Export runs only when {@code
 * -Dppl.lint.grammar.bundle} is set (CI); local runs without it are unaffected.
 *
 * <p>The suite honors {@code -Dppl.lint.schedule=pr|nightly} (default {@code pr}): a PR run skips
 * contracts declaring {@code schedule: "nightly"}, while nightly runs the full corpus. Every
 * contract in the corpus currently declares {@code schedule: "pr"}, so the two are equivalent
 * today; the filter stays because it is the only mechanism for holding a new contract back from PR
 * runs while its oracle is still settling.
 *
 * <p>Note that a contract which RUNS also ASSERTS. This class does not consult the manifest's
 * {@code enforced} list — that list records oracle quality and review status, not blocking
 * behavior. Adding a contract, or moving one onto the PR schedule, makes it capable of failing the
 * required check.
 */
public class PplLintRuleValidationIT extends PPLIntegTestCase {

  private static final String CONTRACT_DIR = "src/test/resources/ppl-lint/contracts";
  private static final String MANIFEST = CONTRACT_DIR + "/manifest.json";
  private static final String GRAMMAR_API_ENDPOINT = "/_plugins/_ppl/_grammar";

  /** Which contracts to run this session; PR is the fast blocking subset. */
  private final String schedule = System.getProperty("ppl.lint.schedule", "pr");

  /**
   * Observe-only mode, used by the multi-version workflow ({@code
   * .github/workflows/ppl-lint-multiversion-validation.yml}).
   *
   * <p>The default mode asserts each case against the expectation pinned for the cluster's version,
   * which is right when the cluster IS the build under test. The multi-version matrix instead
   * points this suite at OLDER released engines, where a disagreement is the very signal being
   * collected — a 3.6 engine that accepts what the contract pins as rejected is a finding for the
   * drift classifier, not a broken test run.
   *
   * <p>So in observe-only mode the suite still runs every query and records the true observed
   * behavior in the report, but does not fail on an expectation mismatch, and does not require an
   * expectation to exist for this version at all. Failures that mean the RUN itself is broken (no
   * grammar bundle, an unreachable cluster, a malformed contract) still fail, because those would
   * otherwise produce an empty report that reads as agreement.
   */
  private final boolean observeOnly = Boolean.getBoolean("ppl.lint.observe.only");

  private int[] clusterVersion;
  private String engineVersionRaw;

  /**
   * Whether this cluster recognizes the Calcite settings at all. False on a pre-Calcite (2.x)
   * engine, where every {@code plugins.calcite.*} write is rejected as "not recognized".
   * Established once in {@code init()} and honored by {@code applyClusterSettings}, so the whole
   * family is skipped rather than retried and failed once per contract.
   */
  private boolean calciteSettingsSupported = true;

  /**
   * Index fixtures that could not be created on this engine (observe-only mode only). Contracts
   * that need one are reported as {@code outcome: "error"} instead of as engine behavior, because
   * an IndexNotFoundException from a missing fixture is not a verdict about the query.
   */
  private final Set<String> unseededIndices = new LinkedHashSet<>();

  @Override
  public void init() throws Exception {
    // Calcite is a 3.x engine feature: on 2.x the cluster rejects
    // `plugins.calcite.enabled` outright with "not recognized", and the base class's
    // init() sets it unconditionally. In observe-only mode (the multi-version
    // matrix) that must not abort the leg — a pre-Calcite engine is a legitimate
    // thing to observe, and the contracts' own `frontendContext.isCalcite` already
    // describes what the linter should assume there.
    //
    // Asserting mode keeps the strict behavior: the required check runs against the
    // PR's own build, where a missing Calcite setting is a real problem.
    try {
      super.init();
      enableCalcite();
    } catch (Exception e) {
      if (!observeOnly || !isUnrecognizedCalciteSetting(e)) {
        throw e;
      }
      calciteSettingsSupported = false;
      System.err.println(
          "[ppl-lint] engine does not support the Calcite settings; observing without them: "
              + e.getMessage());
      // super.init() aborted partway, so redo the part that is version-independent.
      increaseMaxCompilationsRate();
    }
    // Fall through to fixture seeding either way.
    // Seed the union of every index every scheduled contract needs, once.
    for (String indexEnum : requiredIndexEnums()) {
      try {
        loadIndex(Index.valueOf(indexEnum));
      } catch (Exception e) {
        if (!observeOnly) {
          throw e;
        }
        // In the multi-version matrix an older engine may not support a field type
        // a fixture uses (a mapping that only exists in a later release). Losing
        // that one index must not abort the whole leg — every other rule is still
        // validated against this engine.
        //
        // But it must not be silent either: without the index, every query against
        // it fails with IndexNotFoundException, which looks exactly like a real
        // engine verdict. Left unmarked, the drift report would advise pinning the
        // contract to IndexNotFoundException, or "extending the detector" for a
        // control the engine only rejected because its data was missing. Record the
        // failure so those cases are reported as unusable rather than as behavior.
        unseededIndices.add(indexEnum);
        System.err.println(
            "[ppl-lint] could not seed index " + indexEnum + " on this engine: " + e.getMessage());
      }
    }
    clusterVersion = fetchClusterVersion();
  }

  @Test
  public void testValidatesLintRuleContracts() throws IOException {
    List<JSONObject> contracts = loadScheduledContracts();
    List<String> failures = new ArrayList<>();
    JSONArray report = new JSONArray();

    // Export the candidate grammar bundle + target manifest while the cluster is
    // alive. Runs before the contract loop so the artifacts are emitted even if a
    // contract later fails.
    exportGrammarArtifacts(failures);

    for (JSONObject contract : contracts) {
      String ruleId = contract.getString("ruleId");
      runContract(contract, ruleId, failures, report);
    }

    writeReport(report);

    if (!failures.isEmpty()) {
      fail(
          "PPL lint backend contract failures ("
              + failures.size()
              + "):\n- "
              + String.join("\n- ", failures));
    }
  }

  private void runContract(
      JSONObject contract, String ruleId, List<String> failures, JSONArray report)
      throws IOException {
    String index = contract.getString("index");
    JSONObject queries = contract.getJSONObject("queries");
    JSONArray expectations = contract.getJSONArray("expectations");
    JSONObject fixture = contract.optJSONObject("backendFixture");
    boolean calciteOn = fixtureCalciteEnabled(fixture);

    // A contract whose fixture index never got created cannot produce a meaningful
    // observation: every query would fail with IndexNotFoundException regardless of
    // the rule. Report each case as an error so the aggregator counts it as
    // inconclusive rather than as the engine's verdict.
    String missingIndex = missingFixtureIndex(fixture);
    if (missingIndex != null) {
      recordUnusableContract(ruleId, index, queries, report, missingIndex);
      return;
    }

    List<String> applied = applyClusterSettings(fixture);
    try {
      // In observe-only mode, "no expectation matches this version" is information,
      // not a failure — a rule the corpus does not pin for THIS engine is exactly
      // what the multi-version matrix is here to learn. selectExpectation records
      // into whatever list it is handed, so hand it a scratch list we discard;
      // otherwise the leg both records the observation AND fails, which is what
      // kept union-min-datasets (a >=3.7 rule) failing the 3.6 leg.
      List<String> selectionFailures = observeOnly ? new ArrayList<>() : failures;
      JSONObject selected = selectExpectation(ruleId, expectations, calciteOn, selectionFailures);
      if (selected == null) {
        if (!observeOnly) {
          return; // no/ambiguous version expectation — failure already recorded.
        }
        // Record the raw behavior of every query and let the aggregator decide
        // whether the gap matters (out-of-scope rule vs a real coverage hole).
        observeAllQueries(ruleId, index, queries, report);
        return;
      }
      JSONObject expectedQueries = selected.getJSONObject("queries");
      for (String queryName : expectedQueries.keySet()) {
        if (!queries.has(queryName)) {
          failures.add(
              "["
                  + ruleId
                  + "] expectation references unknown query \""
                  + queryName
                  + "\" (not in the top-level queries map)");
          continue;
        }
        JSONObject queryDef = queries.getJSONObject(queryName);
        String role = queryDef.optString("role", "trigger");
        String query = queryDef.getString("query").replace("{{index}}", index);
        JSONObject expected = expectedQueries.getJSONObject(queryName);
        JSONObject backend = expected.getJSONObject("backend");
        String kind = backend.getString("kind");

        JSONObject entry = reportEntry(ruleId, queryName, role, query, kind);
        try {
          verifyCase(kind, queryName, query, backend, entry);
          entry.put("outcome", "pass");
          log(ruleId, queryName, "PASS (" + kind + ", " + role + ")");
        } catch (AssertionError | RuntimeException e) {
          entry.put("outcome", observeOnly ? "observed-mismatch" : "fail");
          entry.put("error", String.valueOf(e.getMessage()));
          if (observeOnly) {
            // Not a failure here: the observation is the deliverable, and the
            // drift classifier turns it into a remediation.
            log(ruleId, queryName, "OBSERVED MISMATCH (" + kind + "): " + e.getMessage());
          } else {
            failures.add("[" + ruleId + "/" + queryName + "] " + e.getMessage());
            log(ruleId, queryName, "FAIL (" + kind + "): " + e.getMessage());
          }
        }
        report.put(entry);
      }
    } finally {
      resetClusterSettings(applied);
    }
  }

  /**
   * The first index fixture this contract needs that failed to seed, or null when every index it
   * declares is present. Only ever non-null in observe-only mode, where a seeding failure is
   * tolerated instead of aborting the leg.
   */
  private String missingFixtureIndex(JSONObject fixture) {
    if (unseededIndices.isEmpty() || fixture == null) {
      return null;
    }
    JSONArray declared = fixture.optJSONArray("indices");
    if (declared == null) {
      return unseededIndices.contains("ACCOUNT") ? "ACCOUNT" : null;
    }
    for (int i = 0; i < declared.length(); i++) {
      String name = declared.getString(i);
      if (unseededIndices.contains(name)) {
        return name;
      }
    }
    return null;
  }

  /**
   * Record every case of a contract whose fixture index is missing as {@code outcome: "error"}, so
   * the multi-version aggregator treats them as inconclusive. Writing nothing at all would be
   * worse: absent rows are indistinguishable from a detector that never ran.
   */
  private void recordUnusableContract(
      String ruleId, String index, JSONObject queries, JSONArray report, String missingIndex) {
    for (String queryName : queries.keySet()) {
      JSONObject queryDef = queries.getJSONObject(queryName);
      String role = queryDef.optString("role", "trigger");
      String query = queryDef.getString("query").replace("{{index}}", index);
      report.put(
          reportEntry(ruleId, queryName, role, query, "observe-only")
              .put("outcome", "error")
              .put(
                  "error",
                  "fixture index " + missingIndex + " could not be created on this engine"));
      log(ruleId, queryName, "SKIPPED (fixture index " + missingIndex + " unavailable)");
    }
  }

  /**
   * Observe-only helper: run every query a contract declares and record what the engine actually
   * did, without comparing against any expectation. Used when this engine version has no matching
   * {@code expectations[]} entry, so the multi-version report still shows real behavior instead of
   * a blank row that would read as agreement.
   */
  private void observeAllQueries(
      String ruleId, String index, JSONObject queries, JSONArray report) {
    for (String queryName : queries.keySet()) {
      JSONObject queryDef = queries.getJSONObject(queryName);
      String role = queryDef.optString("role", "trigger");
      String query = queryDef.getString("query").replace("{{index}}", index);
      JSONObject entry = reportEntry(ruleId, queryName, role, query, "observe-only");
      try {
        BackendObservation obs = observeBackend(query);
        entry
            .put("rejected", obs.rejected)
            .put("observed", obs.toJson())
            .put("outcome", "observed");
        log(ruleId, queryName, "OBSERVED (" + (obs.rejected ? "rejected" : "accepted") + ")");
      } catch (IOException | RuntimeException e) {
        // A transport-level problem is a broken run, not an engine verdict; mark it
        // so the aggregator does not read the absence of a rejection as acceptance.
        entry.put("outcome", "error").put("error", String.valueOf(e.getMessage()));
        log(ruleId, queryName, "ERROR: " + e.getMessage());
      }
      report.put(entry);
    }
  }

  /**
   * Select the single {@code expectations[]} entry that applies to the candidate backend version
   * and engine. Exactly one must match: zero means the rule test does not cover this version
   * (design §9), and more than one means overlapping ranges — both fail before execution (§5.3).
   */
  private JSONObject selectExpectation(
      String ruleId, JSONArray expectations, boolean calciteOn, List<String> failures) {
    List<JSONObject> matches = new ArrayList<>();
    for (int i = 0; i < expectations.length(); i++) {
      JSONObject exp = expectations.getJSONObject(i);
      if (!versionMatchesRange(exp.optString("version", null))) {
        continue;
      }
      String engine = exp.optString("engine", "");
      if ("calcite".equals(engine) && !calciteOn) {
        continue;
      }
      matches.add(exp);
    }
    String versionLabel = engineVersionRaw == null ? "unknown" : engineVersionRaw;
    if (matches.size() == 1) {
      return matches.get(0);
    }
    if (matches.isEmpty()) {
      failures.add(
          "[" + ruleId + "] no version expectation matches backend version " + versionLabel);
    } else {
      failures.add(
          "["
              + ruleId
              + "] "
              + matches.size()
              + " expectations match backend version "
              + versionLabel
              + " (exactly one required)");
    }
    return null;
  }

  private void verifyCase(
      String kind, String queryName, String query, JSONObject backend, JSONObject entry)
      throws IOException {
    BackendObservation obs = observeBackend(query);
    entry.put("rejected", obs.rejected);
    entry.put("observed", obs.toJson());
    switch (kind) {
      case "rejection":
        assertRejection(
            queryName, query, obs, backend.getInt("httpStatus"), backend.getJSONObject("body"));
        break;
      case "result-shape":
        assertResultShape(queryName, query, obs, backend.optJSONObject("expect"));
        break;
      case "advisory":
        assertAdvisory(queryName, query, obs);
        break;
      default:
        throw new IllegalArgumentException(
            "case \"" + queryName + "\": unknown backend.kind \"" + kind + "\"");
    }
  }

  /**
   * Run the query once and categorize the observed backend behavior independently of the
   * expectation, so the report carries the true behavior even when a case fails (e.g. a trigger the
   * backend unexpectedly accepted). A non-2xx surfaces as a {@link ResponseException} from the REST
   * client, which is the rejection signal.
   */
  private BackendObservation observeBackend(String query) throws IOException {
    try {
      JSONObject response = runPplQuery(query);
      return BackendObservation.accepted(response);
    } catch (ResponseException e) {
      int status = e.getResponse().getStatusLine().getStatusCode();
      JSONObject body;
      try {
        body = new JSONObject(getResponseBody(e.getResponse(), true));
      } catch (IOException ioe) {
        throw new RuntimeException(
            "failed to read rejection response body for query: " + query, ioe);
      }
      return BackendObservation.rejected(status, body);
    }
  }

  /** A rejected query must have thrown with the contracted status and structured error fields. */
  private void assertRejection(
      String queryName,
      String query,
      BackendObservation obs,
      int expectedStatus,
      JSONObject expectedBody) {
    assertTrue(
        "case \""
            + queryName
            + "\": expected the backend to REJECT the query but it was accepted: "
            + query,
        obs.rejected);
    assertEquals(
        "case \"" + queryName + "\": unexpected HTTP status for query: " + query,
        expectedStatus,
        obs.status);
    assertEquals(
        "case \"" + queryName + "\": unexpected top-level status field for query: " + query,
        expectedBody.getInt("status"),
        obs.body.getInt("status"));

    // A contract may omit `error` entirely to assert only THAT the engine rejects,
    // without pinning wording that has not been observed live on that version. That
    // is weaker than a full oracle but honest; inventing a type/reason would either
    // fail spuriously or get "fixed" by pinning whatever CI first happened to see.
    if (!expectedBody.has("error")) {
      return;
    }
    JSONObject expectedError = expectedBody.getJSONObject("error");
    JSONObject actualError = obs.body.getJSONObject("error");
    if (expectedError.has("type")) {
      assertEquals(
          "case \"" + queryName + "\": unexpected error.type for query: " + query,
          expectedError.getString("type"),
          actualError.getString("type"));
    }
    if (expectedError.has("reason")) {
      assertEquals(
          "case \"" + queryName + "\": unexpected error.reason for query: " + query,
          expectedError.getString("reason"),
          actualError.getString("reason"));
    }
  }

  /** A result-shape case returns 200 whose datarows match the declared expectations. */
  private void assertResultShape(
      String queryName, String query, BackendObservation obs, JSONObject expect) {
    assertTrue(
        "case \""
            + queryName
            + "\": expected a 200 result but the backend rejected the query: "
            + query,
        !obs.rejected);
    JSONObject response = obs.response;
    assertTrue(
        "case \""
            + queryName
            + "\": expected a datarows array in the 200 response for query: "
            + query,
        response.has("datarows"));
    if (expect == null) {
      return;
    }
    JSONArray datarows = response.getJSONArray("datarows");

    if (expect.optBoolean("datarowsNonEmpty", false)) {
      assertTrue(
          "case \"" + queryName + "\": expected non-empty datarows for query: " + query,
          datarows.length() > 0);
    }
    if (expect.has("datarowsCount")) {
      assertEquals(
          "case \"" + queryName + "\": unexpected datarows count for query: " + query,
          expect.getInt("datarowsCount"),
          datarows.length());
    }
    if (expect.has("columnAllNull")) {
      String column = expect.getString("columnAllNull");
      int columnIndex = schemaColumnIndex(response, column);
      assertTrue(
          "case \""
              + queryName
              + "\": column \""
              + column
              + "\" not found in schema for query: "
              + query,
          columnIndex >= 0);
      assertTrue(
          "case \""
              + queryName
              + "\": expected non-empty datarows to check null column for query: "
              + query,
          datarows.length() > 0);
      for (int r = 0; r < datarows.length(); r++) {
        JSONArray row = datarows.getJSONArray(r);
        assertTrue(
            "case \""
                + queryName
                + "\": expected column \""
                + column
                + "\" to be null in every row but row "
                + r
                + " was "
                + row.get(columnIndex)
                + " for query: "
                + query,
            row.isNull(columnIndex));
      }
    }
  }

  /** An advisory case only requires the query to be accepted (HTTP 200 with data). */
  private void assertAdvisory(String queryName, String query, BackendObservation obs) {
    assertTrue(
        "case \""
            + queryName
            + "\": expected the query to be accepted (advisory) but it was "
            + "rejected: "
            + query,
        !obs.rejected);
    assertTrue(
        "case \""
            + queryName
            + "\": expected a datarows array in the 200 response for query: "
            + query,
        obs.response.has("datarows"));
  }

  /**
   * POST a PPL query to {@code /_plugins/_ppl} with a JSON-escaped body. The inherited {@code
   * executeQuery} raw-interpolates the query into {@code {"query":"%s"}}, so a contract query that
   * contains a double quote (e.g. {@code grok field=body "%{WORD:w}"}) would break the request
   * payload and surface a spurious core-REST parse error instead of the real engine behavior. Build
   * the body with a JSON serializer so any query is sent faithfully. Asserts HTTP 200 (a non-200
   * surfaces as a ResponseException, which the rejection path expects).
   */
  private JSONObject runPplQuery(String query) throws IOException {
    Request request = new Request("POST", QUERY_API_ENDPOINT);
    request.setJsonEntity(new JSONObject().put("query", query).toString());
    RequestOptions.Builder options = RequestOptions.DEFAULT.toBuilder();
    options.addHeader("Content-Type", "application/json");
    request.setOptions(options);

    Response response = client().performRequest(request);
    assertEquals(200, response.getStatusLine().getStatusCode());
    return new JSONObject(getResponseBody(response, true));
  }

  private int schemaColumnIndex(JSONObject response, String column) {
    if (!response.has("schema")) {
      return -1;
    }
    JSONArray schema = response.getJSONArray("schema");
    for (int i = 0; i < schema.length(); i++) {
      JSONObject col = schema.getJSONObject(i);
      String name = col.optString("alias", col.optString("name", ""));
      if (column.equals(name) || column.equals(col.optString("name", ""))) {
        return i;
      }
    }
    return -1;
  }

  /** Observed backend behavior for one query, captured before asserting the expectation. */
  private static final class BackendObservation {
    final boolean rejected;
    final int status;
    final JSONObject body; // rejection body, or null when accepted
    final JSONObject response; // accepted 200 response, or null when rejected

    private BackendObservation(boolean rejected, int status, JSONObject body, JSONObject response) {
      this.rejected = rejected;
      this.status = status;
      this.body = body;
      this.response = response;
    }

    static BackendObservation accepted(JSONObject response) {
      return new BackendObservation(false, 200, null, response);
    }

    static BackendObservation rejected(int status, JSONObject body) {
      return new BackendObservation(true, status, body, null);
    }

    JSONObject toJson() {
      JSONObject o = new JSONObject().put("httpStatus", status).put("rejected", rejected);
      if (body != null) {
        JSONObject err = body.optJSONObject("error");
        if (err != null) {
          o.put("type", err.opt("type")).put("reason", err.opt("reason"));
        }
      }
      return o;
    }
  }

  // --- grammar bundle export -------------------------------------------------

  /**
   * Fetch the candidate runtime grammar bundle and write it plus a target manifest, so the
   * detector-validation job can lint against the SAME grammar this backend built. Best-effort by
   * design: a run without {@code -Dppl.lint.grammar.bundle} (local dev) exports nothing; in CI a
   * fetch/write failure is a real failure — a missing bundle means the detector half cannot run.
   */
  private void exportGrammarArtifacts(List<String> failures) {
    String bundlePath = System.getProperty("ppl.lint.grammar.bundle");
    if (bundlePath == null || bundlePath.isEmpty()) {
      // No bundle requested. That is a compiled-surface leg (an engine predating
      // GET /_plugins/_ppl/_grammar) or a local run. The target manifest still has
      // to be written: it carries the engine version every consumer keys on, and
      // the multi-version aggregator treats a leg without one as fatal. Writing it
      // only alongside the bundle silently produced legs the aggregator could not
      // read.
      writeTargetManifest("", failures);
      return;
    }
    try {
      Response response = client().performRequest(new Request("GET", GRAMMAR_API_ENDPOINT));
      String bundleBody = getResponseBody(response, true);
      Files.write(Paths.get(bundlePath), bundleBody.getBytes(StandardCharsets.UTF_8));

      JSONObject bundle = new JSONObject(bundleBody);
      String grammarHash = bundle.optString("grammarHash", "");
      writeTargetManifest(grammarHash, Paths.get(bundlePath).getFileName().toString(), failures);
      log("_grammar", "export", "wrote candidate bundle (" + grammarHash + ") to " + bundlePath);
    } catch (Exception e) {
      failures.add(
          "[grammar-export] failed to fetch/write " + GRAMMAR_API_ENDPOINT + ": " + e.getMessage());
    }
  }

  /** Target manifest for a leg with no grammar bundle (compiled surface / local run). */
  /**
   * True when a failure is the cluster rejecting {@code plugins.calcite.enabled} because it does
   * not know that setting — i.e. a pre-Calcite (2.x) engine.
   *
   * <p>Deliberately narrow: matched on the setting name plus "not recognized" rather than on any
   * 400, so a genuinely broken settings call on a Calcite-capable engine still fails the run
   * instead of being waved through as "old engine".
   */
  private static boolean isUnrecognizedCalciteSetting(Throwable error) {
    for (Throwable current = error; current != null; current = current.getCause()) {
      String message = current.getMessage();
      if (message != null
          && message.contains(Settings.Key.CALCITE_ENGINE_ENABLED.getKeyValue())
          && message.contains("not recognized")) {
        return true;
      }
      if (current.getCause() == current) {
        break;
      }
    }
    return false;
  }

  private void writeTargetManifest(String grammarHash, List<String> failures) {
    writeTargetManifest(grammarHash, "", failures);
  }

  /**
   * Write {@code ppl.lint.target}: the engine version, the grammar hash when there is one, and the
   * bundle filename when one was exported. Every consumer keys on {@code engineVersion}, so this is
   * written whether or not a bundle exists.
   */
  private void writeTargetManifest(String grammarHash, String bundleName, List<String> failures) {
    String targetPath = System.getProperty("ppl.lint.target");
    if (targetPath == null || targetPath.isEmpty()) {
      return;
    }
    try {
      JSONObject target =
          new JSONObject()
              .put("engineVersion", engineVersionRaw == null ? "" : engineVersionRaw)
              .put("grammarHash", grammarHash)
              .put("grammarBundle", bundleName);
      Files.write(Paths.get(targetPath), target.toString(2).getBytes(StandardCharsets.UTF_8));
    } catch (Exception e) {
      failures.add("[grammar-export] failed to write " + targetPath + ": " + e.getMessage());
    }
  }

  // --- cluster settings ------------------------------------------------------

  /** True when the contract's fixture leaves Calcite enabled (the default). */
  private boolean fixtureCalciteEnabled(JSONObject fixture) {
    if (fixture == null) {
      return true;
    }
    JSONObject settings = fixture.optJSONObject("clusterSettings");
    if (settings == null || !settings.has("calcite")) {
      return true;
    }
    return settings.getBoolean("calcite");
  }

  /**
   * Apply the contract's cluster settings and return the list of settings changed so the caller can
   * reset them afterwards. Grouped per-contract (not global) because contracts disagree: eventstats
   * needs {@code calciteFallback=false} to force rejection, while dedup-consecutive needs it {@code
   * true} to succeed via V2 fallback.
   */
  private List<String> applyClusterSettings(JSONObject fixture) throws IOException {
    List<String> applied = new ArrayList<>();
    if (fixture == null) {
      return applied;
    }
    JSONObject settings = fixture.optJSONObject("clusterSettings");
    if (settings == null) {
      return applied;
    }
    // Every setting below is Calcite-family, and a pre-Calcite engine rejects all of
    // them the same way. `init()` already established whether this cluster knows
    // them, so skip the whole block rather than fail per contract — otherwise the
    // tolerance added there is undone here, once per contract.
    if (!calciteSettingsSupported) {
      return applied;
    }
    if (settings.has("calcite")) {
      if (settings.getBoolean("calcite")) {
        enableCalcite();
      } else {
        disableCalcite();
      }
    }
    if (settings.has("calciteFallback")) {
      if (settings.getBoolean("calciteFallback")) {
        allowCalciteFallback();
      } else {
        disallowCalciteFallback();
      }
    }
    if (settings.has("allJoinTypesAllowed")) {
      String key = Settings.Key.CALCITE_SUPPORT_ALL_JOIN_TYPES.getKeyValue();
      String value = Boolean.toString(settings.getBoolean("allJoinTypesAllowed"));
      updateClusterSettings(new PPLIntegTestCase.ClusterSetting("persistent", key, value));
      applied.add(key);
    }
    return applied;
  }

  /**
   * Reset each explicitly-applied dynamic setting to its cluster default by writing a null value.
   * (calcite/calciteFallback are toggled via the inherited helpers and re-set explicitly by each
   * contract, so only the persistent settings applied here are reset.)
   */
  private void resetClusterSettings(List<String> appliedKeys) {
    for (String key : appliedKeys) {
      try {
        updateClusterSettings(new PPLIntegTestCase.ClusterSetting("persistent", key, null));
      } catch (IOException e) {
        // Best-effort reset; the next contract sets what it needs explicitly, so
        // keep the failure visible without failing the suite.
        System.err.println("[ppl-lint] failed to reset a cluster setting: " + e.getMessage());
      }
    }
  }

  // --- version gating --------------------------------------------------------

  private int[] fetchClusterVersion() {
    try {
      Response response = client().performRequest(new Request("GET", "/"));
      JSONObject body = new JSONObject(getResponseBody(response, false));
      String number = body.getJSONObject("version").getString("number");
      engineVersionRaw = number;
      return parseVersion(number);
    } catch (Exception e) {
      // Unknown version → do not skip anything.
      return null;
    }
  }

  /**
   * Test a space-separated semver range (e.g. {@code ">=3.6.0 <3.8.0"}) against the candidate
   * backend version. An empty/absent range or an unknown cluster version matches (do not
   * over-filter). Supports the {@code >= > <= < =} comparators the design uses.
   */
  private boolean versionMatchesRange(String range) {
    if (range == null || range.trim().isEmpty()) {
      return true;
    }
    if (clusterVersion == null) {
      return true;
    }
    for (String token : range.trim().split("\\s+")) {
      if (!satisfiesComparator(token)) {
        return false;
      }
    }
    return true;
  }

  private boolean satisfiesComparator(String token) {
    String op;
    String ver;
    if (token.startsWith(">=")) {
      op = ">=";
      ver = token.substring(2);
    } else if (token.startsWith("<=")) {
      op = "<=";
      ver = token.substring(2);
    } else if (token.startsWith(">")) {
      op = ">";
      ver = token.substring(1);
    } else if (token.startsWith("<")) {
      op = "<";
      ver = token.substring(1);
    } else if (token.startsWith("=")) {
      op = "=";
      ver = token.substring(1);
    } else {
      op = "=";
      ver = token;
    }
    int cmp = compareVersion(clusterVersion, parseVersion(ver));
    switch (op) {
      case ">=":
        return cmp >= 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case "<":
        return cmp < 0;
      default:
        return cmp == 0;
    }
  }

  private int compareVersion(int[] a, int[] b) {
    for (int i = 0; i < 3; i++) {
      if (a[i] != b[i]) {
        return Integer.compare(a[i], b[i]);
      }
    }
    return 0;
  }

  private int[] parseVersion(String raw) {
    String cleaned = raw.split("-")[0];
    String[] parts = cleaned.split("\\.");
    int[] v = new int[] {0, 0, 0};
    for (int i = 0; i < 3 && i < parts.length; i++) {
      try {
        v[i] = Integer.parseInt(parts[i]);
      } catch (NumberFormatException ignored) {
        v[i] = 0;
      }
    }
    return v;
  }

  // --- contract loading ------------------------------------------------------

  private List<JSONObject> loadScheduledContracts() throws IOException {
    List<JSONObject> result = new ArrayList<>();
    for (String fileName : manifestContractNames()) {
      JSONObject contract = loadContractFile(CONTRACT_DIR + "/" + fileName);
      String contractSchedule = contract.optString("schedule", "pr");
      if ("pr".equals(schedule) && !"pr".equals(contractSchedule)) {
        continue; // PR runs only PR-scheduled contracts; nightly runs all.
      }
      result.add(contract);
    }
    return result;
  }

  private List<String> manifestContractNames() throws IOException {
    JSONObject manifest = loadContractFile(MANIFEST);
    JSONArray contracts = manifest.getJSONArray("contracts");
    List<String> names = new ArrayList<>();
    for (int i = 0; i < contracts.length(); i++) {
      names.add(contracts.getString(i));
    }
    return names;
  }

  /** Union of index enums required by the contracts scheduled to run this session. */
  private Set<String> requiredIndexEnums() throws IOException {
    Set<String> indices = new LinkedHashSet<>();
    for (JSONObject contract : loadScheduledContracts()) {
      JSONObject fixture = contract.optJSONObject("backendFixture");
      if (fixture == null) {
        continue;
      }
      JSONArray declared = fixture.optJSONArray("indices");
      if (declared == null) {
        continue;
      }
      for (int i = 0; i < declared.length(); i++) {
        indices.add(declared.getString(i));
      }
    }
    if (indices.isEmpty()) {
      indices.add("ACCOUNT");
    }
    return indices;
  }

  private JSONObject loadContractFile(String resourcePath) throws IOException {
    String path = TestUtils.getResourceFilePath(resourcePath);
    return new JSONObject(new String(Files.readAllBytes(Paths.get(path))));
  }

  // --- reporting -------------------------------------------------------------

  private JSONObject reportEntry(
      String ruleId, String queryName, String role, String query, String kind) {
    return new JSONObject()
        .put("ruleId", ruleId)
        .put("queryName", queryName)
        .put("role", role)
        .put("query", query)
        .put("kind", kind);
  }

  private void writeReport(JSONArray report) {
    String target = System.getProperty("ppl.lint.report");
    if (target == null || target.isEmpty()) {
      return;
    }
    try {
      Files.write(Paths.get(target), report.toString(2).getBytes(StandardCharsets.UTF_8));
    } catch (IOException e) {
      System.err.println("[ppl-lint] could not write backend report to " + target + ": " + e);
    }
  }

  private void log(String ruleId, String caseId, String message) {
    System.out.println(
        String.format(
            Locale.ROOT, "[ppl-lint-backend-contract] %s/%s: %s", ruleId, caseId, message));
  }
}
