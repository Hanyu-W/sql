/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

package org.opensearch.sql.calcite.remote;

import static org.opensearch.sql.legacy.TestUtils.getResponseBody;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.jupiter.api.Test;
import org.opensearch.client.ResponseException;
import org.opensearch.sql.legacy.TestUtils;
import org.opensearch.sql.ppl.PPLIntegTestCase;

/**
 * Backend half of the PPL lint rule validation contract.
 *
 * <p>This test drives the live {@code POST /_plugins/_ppl} endpoint on the SQL plugin built from
 * the current checkout and asserts, per contract case, that:
 *
 * <ul>
 *   <li>a rejected query returns the contracted HTTP status and structured error body ({@code
 *       status}, {@code error.type}, {@code error.reason}); and
 *   <li>a valid control query returns HTTP 200 with data.
 * </ul>
 *
 * <p>The contract file is shared verbatim with the SQL-owned OSD frontend adapter ({@code
 * scripts/ppl-lint/run-frontend-contract.mjs}) so the same reviewed cases pin both the OSD analyzer
 * diagnostic and the SQL backend behavior. The rejection-body parsing mirrors the existing {@link
 * org.opensearch.sql.calcite.remote.CalciteErrorReportStageIT} pattern; the live fixture and
 * Calcite setup follow {@link org.opensearch.sql.calcite.remote.CalcitePPLEventstatsIT}.
 */
public class PplLintRuleValidationIT extends PPLIntegTestCase {

  private static final String CONTRACT_RESOURCE =
      "src/test/resources/ppl-lint/unsupported-window-function-in-eventstats.spec.json";

  @Override
  public void init() throws Exception {
    super.init();
    // eventstats via the Calcite path. Disallow fallback so an unsupported window function is
    // rejected rather than silently degrading to the V2 engine.
    enableCalcite();
    disallowCalciteFallback();
    loadIndex(Index.ACCOUNT);
  }

  @Test
  public void testValidatesUnsupportedWindowFunctionContract() throws IOException {
    JSONObject contract = loadContract();
    String index = contract.getString("index");
    JSONArray cases = contract.getJSONArray("cases");

    for (int i = 0; i < cases.length(); i++) {
      JSONObject testCase = cases.getJSONObject(i);
      String caseId = testCase.getString("id");
      String query = testCase.getString("query").replace("{{index}}", index);
      JSONObject backendExpected = testCase.getJSONObject("backendExpected");
      int expectedStatus = backendExpected.getInt("httpStatus");

      if (expectedStatus == 200) {
        verifyAcceptedCase(caseId, query);
      } else {
        verifyRejectedCase(caseId, query, expectedStatus, backendExpected.getJSONObject("body"));
      }
    }
  }

  /** A valid control query must return HTTP 200. executeQuery already asserts the 200 status. */
  private void verifyAcceptedCase(String caseId, String query) throws IOException {
    JSONObject response = executeQuery(query);
    assertTrue(
        "case \""
            + caseId
            + "\": expected a datarows array in the 200 response for query: "
            + query,
        response.has("datarows"));
  }

  /**
   * A rejected query must throw a {@link ResponseException} whose response carries the contracted
   * HTTP status and structured error fields. executeQuery internally asserts 200, so a non-200
   * response surfaces as a ResponseException before it can return.
   */
  private void verifyRejectedCase(
      String caseId, String query, int expectedStatus, JSONObject expectedBody) {
    ResponseException exception = assertThrows(ResponseException.class, () -> executeQuery(query));

    int actualStatus = exception.getResponse().getStatusLine().getStatusCode();
    assertEquals(
        "case \"" + caseId + "\": unexpected HTTP status for query: " + query,
        expectedStatus,
        actualStatus);

    JSONObject body;
    try {
      body = new JSONObject(getResponseBody(exception.getResponse(), true));
    } catch (IOException e) {
      throw new RuntimeException(
          "case \"" + caseId + "\": failed to read rejection response body for query: " + query, e);
    }

    assertEquals(
        "case \"" + caseId + "\": unexpected top-level status field for query: " + query,
        expectedBody.getInt("status"),
        body.getInt("status"));

    JSONObject expectedError = expectedBody.getJSONObject("error");
    JSONObject actualError = body.getJSONObject("error");

    assertEquals(
        "case \"" + caseId + "\": unexpected error.type for query: " + query,
        expectedError.getString("type"),
        actualError.getString("type"));
    assertEquals(
        "case \"" + caseId + "\": unexpected error.reason for query: " + query,
        expectedError.getString("reason"),
        actualError.getString("reason"));
  }

  private JSONObject loadContract() throws IOException {
    String path = TestUtils.getResourceFilePath(CONTRACT_RESOURCE);
    return new JSONObject(new String(Files.readAllBytes(Paths.get(path))));
  }
}
