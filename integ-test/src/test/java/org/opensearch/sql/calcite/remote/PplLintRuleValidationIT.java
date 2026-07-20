/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

package org.opensearch.sql.calcite.remote;

import static org.opensearch.sql.legacy.TestUtils.getResponseBody;
import static org.opensearch.sql.plugin.rest.RestPPLQueryAction.QUERY_API_ENDPOINT;

import java.io.IOException;
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
 * Backend half of the schema-v2 PPL lint rule validation contract.
 *
 * <p>This test drives the live {@code POST /_plugins/_ppl} endpoint on the SQL plugin built from
 * the current checkout. For every contract case (see {@code
 * src/test/resources/ppl-lint/contracts/*.spec.json}) it applies the case's cluster settings and
 * asserts, per {@code backend.kind}:
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
 * <p>The contract files are shared verbatim with the SQL-owned OSD frontend adapter ({@code
 * scripts/ppl-lint/run-frontend-contract.mjs}) so the same reviewed cases pin both the OSD analyzer
 * diagnostic count and the SQL backend behavior; neither side can drift without a red build. The
 * rejection-body parsing mirrors {@link
 * org.opensearch.sql.calcite.remote.CalciteErrorReportStageIT}; the Calcite setup follows {@link
 * org.opensearch.sql.calcite.remote.CalcitePPLEventstatsIT}.
 *
 * <p>The suite honors {@code -Dppl.lint.schedule=pr|nightly} (default {@code pr}): PR runs only the
 * fast, deterministic {@code schedule:pr} contracts; nightly runs the full corpus including the
 * runtime-only and softer-oracle rules.
 */
public class PplLintRuleValidationIT extends PPLIntegTestCase {

  private static final String CONTRACT_DIR = "src/test/resources/ppl-lint/contracts";
  private static final String MANIFEST = CONTRACT_DIR + "/manifest.json";

  /** Which contracts to run this session; PR is the fast blocking subset. */
  private final String schedule = System.getProperty("ppl.lint.schedule", "pr");

  private int[] clusterVersion;

  @Override
  public void init() throws Exception {
    super.init();
    enableCalcite();
    // Seed the union of every index every scheduled contract needs, once.
    for (String indexEnum : requiredIndexEnums()) {
      loadIndex(Index.valueOf(indexEnum));
    }
    clusterVersion = fetchClusterVersion();
  }

  @Test
  public void testValidatesLintRuleContracts() throws IOException {
    List<JSONObject> contracts = loadScheduledContracts();
    List<String> failures = new ArrayList<>();
    JSONArray report = new JSONArray();

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
    JSONArray cases = contract.getJSONArray("cases");
    JSONObject fixture = contract.optJSONObject("backendFixture");

    List<String> applied = applyClusterSettings(fixture);
    try {
      for (int i = 0; i < cases.length(); i++) {
        JSONObject testCase = cases.getJSONObject(i);
        String caseId = testCase.getString("id");
        String query = testCase.getString("query").replace("{{index}}", index);

        String minVersion = testCase.optString("minVersionRequired", null);
        if (minVersion != null && !versionAtLeast(minVersion)) {
          log(ruleId, caseId, "SKIP (needs >= " + minVersion + ")");
          continue;
        }

        JSONObject backend = resolveBackend(testCase);
        String kind = backend.getString("kind");
        JSONObject entry = reportEntry(ruleId, caseId, query, kind);
        try {
          verifyCase(kind, caseId, query, backend, entry);
          entry.put("outcome", "pass");
          log(ruleId, caseId, "PASS (" + kind + ")");
        } catch (AssertionError | RuntimeException e) {
          entry.put("outcome", "fail").put("error", String.valueOf(e.getMessage()));
          failures.add("[" + ruleId + "/" + caseId + "] " + e.getMessage());
          log(ruleId, caseId, "FAIL (" + kind + "): " + e.getMessage());
        }
        report.put(entry);
      }
    } finally {
      resetClusterSettings(applied);
    }
  }

  private void verifyCase(
      String kind, String caseId, String query, JSONObject backend, JSONObject reportEntry)
      throws IOException {
    switch (kind) {
      case "rejection":
        verifyRejectedCase(
            caseId,
            query,
            backend.getInt("httpStatus"),
            backend.getJSONObject("body"),
            reportEntry);
        break;
      case "result-shape":
        verifyResultShape(caseId, query, backend.optJSONObject("expect"));
        break;
      case "advisory":
        verifyAdvisory200(caseId, query);
        break;
      default:
        throw new IllegalArgumentException(
            "case \"" + caseId + "\": unknown backend.kind \"" + kind + "\"");
    }
  }

  /** Back-compat: accept both v2 {@code backend} and the legacy {@code backendExpected} shape. */
  private JSONObject resolveBackend(JSONObject testCase) {
    if (testCase.has("backend")) {
      return testCase.getJSONObject("backend");
    }
    JSONObject legacy = testCase.getJSONObject("backendExpected");
    int status = legacy.getInt("httpStatus");
    JSONObject backend = new JSONObject();
    if (status == 200) {
      return backend.put("kind", "result-shape").put("httpStatus", 200);
    }
    return backend
        .put("kind", "rejection")
        .put("httpStatus", status)
        .put("body", legacy.getJSONObject("body"));
  }

  /** A rejected query must throw with the contracted status and structured error fields. */
  private void verifyRejectedCase(
      String caseId,
      String query,
      int expectedStatus,
      JSONObject expectedBody,
      JSONObject reportEntry) {
    ResponseException exception = assertThrows(ResponseException.class, () -> runPplQuery(query));

    int actualStatus = exception.getResponse().getStatusLine().getStatusCode();

    JSONObject body;
    try {
      body = new JSONObject(getResponseBody(exception.getResponse(), true));
    } catch (IOException e) {
      throw new RuntimeException(
          "case \"" + caseId + "\": failed to read rejection response body for query: " + query, e);
    }

    // Record the observed status/type/reason before asserting so backend-report.json
    // carries the byte-exact engine wording even for a failing case — this is what
    // the snapshot should be updated to when the contract is deliberately changed.
    JSONObject observed = new JSONObject().put("httpStatus", actualStatus);
    JSONObject actualError = body.optJSONObject("error");
    if (actualError != null) {
      observed.put("type", actualError.opt("type")).put("reason", actualError.opt("reason"));
    }
    reportEntry.put("observed", observed);

    assertEquals(
        "case \"" + caseId + "\": unexpected HTTP status for query: " + query,
        expectedStatus,
        actualStatus);

    assertEquals(
        "case \"" + caseId + "\": unexpected top-level status field for query: " + query,
        expectedBody.getInt("status"),
        body.getInt("status"));

    JSONObject expectedError = expectedBody.getJSONObject("error");

    assertEquals(
        "case \"" + caseId + "\": unexpected error.type for query: " + query,
        expectedError.getString("type"),
        actualError.getString("type"));
    if (expectedError.has("reason")) {
      assertEquals(
          "case \"" + caseId + "\": unexpected error.reason for query: " + query,
          expectedError.getString("reason"),
          actualError.getString("reason"));
    }
  }

  /** A result-shape case returns 200 whose datarows match the declared expectations. */
  private void verifyResultShape(String caseId, String query, JSONObject expect)
      throws IOException {
    JSONObject response = runPplQuery(query);
    assertTrue(
        "case \""
            + caseId
            + "\": expected a datarows array in the 200 response for query: "
            + query,
        response.has("datarows"));
    if (expect == null) {
      return;
    }
    JSONArray datarows = response.getJSONArray("datarows");

    if (expect.optBoolean("datarowsNonEmpty", false)) {
      assertTrue(
          "case \"" + caseId + "\": expected non-empty datarows for query: " + query,
          datarows.length() > 0);
    }
    if (expect.has("datarowsCount")) {
      assertEquals(
          "case \"" + caseId + "\": unexpected datarows count for query: " + query,
          expect.getInt("datarowsCount"),
          datarows.length());
    }
    if (expect.has("columnAllNull")) {
      String column = expect.getString("columnAllNull");
      int columnIndex = schemaColumnIndex(response, column);
      assertTrue(
          "case \""
              + caseId
              + "\": column \""
              + column
              + "\" not found in schema for query: "
              + query,
          columnIndex >= 0);
      assertTrue(
          "case \""
              + caseId
              + "\": expected non-empty datarows to check null column for query: "
              + query,
          datarows.length() > 0);
      for (int r = 0; r < datarows.length(); r++) {
        JSONArray row = datarows.getJSONArray(r);
        assertTrue(
            "case \""
                + caseId
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
  private void verifyAdvisory200(String caseId, String query) throws IOException {
    JSONObject response = runPplQuery(query);
    assertTrue(
        "case \""
            + caseId
            + "\": expected a datarows array in the 200 response for query: "
            + query,
        response.has("datarows"));
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

  // --- cluster settings ------------------------------------------------------

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
      return parseVersion(number);
    } catch (Exception e) {
      // Unknown version → do not skip anything.
      return null;
    }
  }

  private boolean versionAtLeast(String required) {
    if (clusterVersion == null) {
      return true;
    }
    int[] want = parseVersion(required);
    for (int i = 0; i < 3; i++) {
      if (clusterVersion[i] > want[i]) return true;
      if (clusterVersion[i] < want[i]) return false;
    }
    return true;
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

  private JSONObject reportEntry(String ruleId, String caseId, String query, String kind) {
    return new JSONObject()
        .put("ruleId", ruleId)
        .put("caseId", caseId)
        .put("query", query)
        .put("kind", kind);
  }

  private void writeReport(JSONArray report) {
    String target = System.getProperty("ppl.lint.report");
    if (target == null || target.isEmpty()) {
      return;
    }
    try {
      Files.write(Paths.get(target), report.toString(2).getBytes());
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
