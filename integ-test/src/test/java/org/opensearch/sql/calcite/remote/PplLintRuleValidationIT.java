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
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
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
 * Backend half of the schema-v3/schema-v4 PPL frontend validation contract.
 *
 * <p>This test drives the live {@code POST /_plugins/_ppl} endpoint on the SQL plugin built from
 * the current checkout. For every contract (see {@code
 * src/test/resources/ppl-lint/contracts/*.spec.json}) it selects the single {@code expectations[]}
 * entry that matches the candidate backend version (exactly one must match, or the contract fails
 * before any query runs), applies the contract's cluster settings, and asserts the oracle selected
 * for {@code ppl.lint.execution_backend}:
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
 * <p>The contract files are shared verbatim with the SQL-owned OSD frontend runner ({@code
 * scripts/ppl-lint/run-frontend-contract.mjs}) so the same reviewed cases pin both the OSD analyzer
 * output and the SQL backend behavior; neither side can drift without a red build. The
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
 * contracts declaring {@code schedule: "nightly"}, while nightly runs all 12 active detector
 * contracts. The filter holds new detector contracts back from PR runs while their standard and
 * analytics oracles are still settling.
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
  private static final String EXECUTION_BACKEND_PROPERTY = "ppl.lint.execution_backend";
  private static final String ANALYTICS_SHARD_COUNT_PROPERTY = "tests.analytics.num_shards";
  private static final String[] REQUIRED_ANALYTICS_PLUGIN_COMPONENTS = {
    "job-scheduler",
    "arrow-base",
    "arrow-flight-rpc",
    "analytics-engine",
    "analytics-backend-lucene",
    "analytics-backend-datafusion",
    "parquet-data-format",
    "composite-engine",
    "opensearch-sql"
  };

  /** Which contracts to run this session; PR is the fast blocking subset. */
  private final String schedule = System.getProperty("ppl.lint.schedule", "pr");

  /** Execution route whose backend oracle and artifact identity this run represents. */
  private final ExecutionBackend executionBackend =
      ExecutionBackend.parse(System.getProperty(EXECUTION_BACKEND_PROPERTY, "standard"));

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
  private final JSONObject analyticsRouteAttestation =
      new JSONObject()
          .put("pluginsVerified", false)
          .put("clusterSettingsVerified", false)
          .put("fixtureIndicesVerified", false)
          .put("explainVerified", false)
          .put("profiledExecutionVerified", false);

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
    clusterVersion = fetchClusterVersion();

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
  }

  @Test
  public void testValidatesLintRuleContracts() throws IOException {
    List<JSONObject> contracts = loadScheduledContracts();
    List<String> failures = new ArrayList<>();
    JSONArray report = new JSONArray();
    if (contracts.isEmpty()) {
      failures.add("[contracts] no contracts were selected for schedule \"" + schedule + "\"");
    }

    boolean routeAttested =
        executionBackend != ExecutionBackend.ANALYTICS || attestAnalyticsRoute(failures);

    // Export the candidate grammar bundle + target manifest while the cluster is
    // alive. Runs before the contract loop so the artifacts are emitted even if a
    // contract later fails.
    exportGrammarArtifacts(failures);

    // A failed route attestation is infrastructure failure, not backend behavior.
    // Do not score any contract against a route that was not proven.
    if (routeAttested) {
      for (JSONObject contract : contracts) {
        String ruleId = contract.getString("ruleId");
        runContract(contract, ruleId, failures, report);
      }
    } else {
      recordUnattestedRouteContracts(contracts, report);
    }

    try {
      writeReport(report);
    } catch (IOException e) {
      failures.add("[report] failed to write backend report: " + e.getMessage());
    }

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
    int schemaVersion = contract.getInt("schemaVersion");
    if (schemaVersion != 3 && schemaVersion != 4) {
      failures.add(
          "[" + ruleId + "] unsupported schemaVersion " + schemaVersion + " (expected 3 or 4)");
      return;
    }

    String index = contract.getString("index");
    JSONObject queries = contract.getJSONObject("queries");
    JSONArray expectations = contract.getJSONArray("expectations");
    JSONObject fixture = contract.optJSONObject("backendFixture");
    boolean calciteOn = fixtureCalciteEnabled(fixture);

    if (expectations.length() == 0) {
      failures.add("[" + ruleId + "] expectations must not be empty");
      return;
    }

    if (!validateAllExpectations(ruleId, queries, expectations, schemaVersion, failures)) {
      return;
    }

    List<JSONObject> matches = matchingExpectations(expectations, calciteOn);
    if (matches.size() > 1) {
      failures.add(
          "["
              + ruleId
              + "] "
              + matches.size()
              + " expectations match backend version "
              + backendVersionLabel()
              + " (exactly one required)");
      return;
    }

    JSONObject selected = matches.isEmpty() ? null : matches.get(0);
    if (selected == null && !observeOnly) {
      failures.add(
          "["
              + ruleId
              + "] no version expectation matches backend version "
              + backendVersionLabel());
      return;
    }

    JSONObject expectedQueries = selected == null ? null : selected.getJSONObject("queries");

    // A contract whose fixture index never got created cannot produce a meaningful
    // observation: every query would fail with IndexNotFoundException regardless of
    // the rule. Report each case as an error so the aggregator counts it as
    // inconclusive rather than as the engine's verdict.
    String missingIndex = missingFixtureIndex(fixture);
    if (missingIndex != null) {
      recordUnusableContract(ruleId, index, queries, report, missingIndex);
      return;
    }

    if (!observeOnly
        && recordEnforcementCoverageGaps(
            ruleId, index, queries, expectedQueries, schemaVersion, failures, report)) {
      return;
    }

    List<String> applied = applyClusterSettings(fixture);
    try {
      if (selected == null) {
        // Record the raw behavior of every query and let the aggregator decide
        // whether the gap matters (out-of-scope rule vs a real coverage hole).
        observeAllQueries(ruleId, index, queries, failures, report);
        return;
      }

      for (String queryName : queries.keySet()) {
        JSONObject queryDef = queries.getJSONObject(queryName);
        String role = queryDef.optString("role", "trigger");
        String query = queryDef.getString("query").replace("{{index}}", index);
        JSONObject expected = expectedQueries.getJSONObject(queryName);
        JSONObject backend = resolveBackendOracle(schemaVersion, expected);
        if (backend == null) {
          recordMissingOracle(ruleId, queryName, role, query, schemaVersion, failures, report);
          continue;
        }

        String kind = backend.getString("kind");

        JSONObject entry = reportEntry(ruleId, queryName, role, query, kind);
        if ("not-applicable".equals(kind)) {
          recordNotApplicable(ruleId, queryName, backend, entry, report);
          continue;
        }

        try {
          verifyCase(kind, queryName, query, backend, entry);
          entry.put("outcome", "pass");
          log(ruleId, queryName, "PASS (" + kind + ", " + role + ")");
        } catch (IOException e) {
          entry.put("outcome", "error").put("error", String.valueOf(e.getMessage()));
          failures.add(
              "["
                  + ruleId
                  + "/"
                  + queryName
                  + "] backend query transport failed: "
                  + String.valueOf(e.getMessage()));
          log(ruleId, queryName, "ERROR (" + kind + "): " + e.getMessage());
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
   * Route attestation failure prevents query execution, but it must not produce a misleadingly
   * empty report. Emit one non-verdict row per query; explicit, complete non-applicable rows remain
   * non-applicable because they do not depend on the unavailable fixture.
   */
  private void recordUnattestedRouteContracts(List<JSONObject> contracts, JSONArray report) {
    for (JSONObject contract : contracts) {
      String ruleId = contract.getString("ruleId");
      String index = contract.getString("index");
      JSONObject queries = contract.getJSONObject("queries");
      JSONObject fixture = contract.optJSONObject("backendFixture");
      List<JSONObject> matches =
          matchingExpectations(
              contract.getJSONArray("expectations"), fixtureCalciteEnabled(fixture));
      JSONObject expectedQueries =
          matches.size() == 1 ? matches.get(0).optJSONObject("queries") : null;

      for (String queryName : queries.keySet()) {
        JSONObject queryDef = queries.getJSONObject(queryName);
        String role = queryDef.optString("role", "trigger");
        String query = queryDef.getString("query").replace("{{index}}", index);
        JSONObject expected =
            expectedQueries == null ? null : expectedQueries.optJSONObject(queryName);
        JSONObject backend = null;
        int schemaVersion = contract.optInt("schemaVersion");
        if (expected != null && (schemaVersion == 3 || schemaVersion == 4)) {
          try {
            backend = resolveBackendOracle(schemaVersion, expected);
          } catch (RuntimeException ignored) {
            // Malformed contracts are still failures; keep this report row as a non-verdict.
          }
        }
        JSONObject entry = reportEntry(ruleId, queryName, role, query, "route-attestation-failed");
        if (isCompleteNotApplicableOracle(backend)) {
          entry.put("kind", "not-applicable");
          recordNotApplicable(ruleId, queryName, backend, entry, report);
        } else {
          report.put(
              entry
                  .put("outcome", "error")
                  .put("error", "analytics route attestation failed before contract execution"));
        }
      }
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
      String ruleId, String index, JSONObject queries, List<String> failures, JSONArray report) {
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
        failures.add(
            "["
                + ruleId
                + "/"
                + queryName
                + "] backend observation failed: "
                + String.valueOf(e.getMessage()));
        log(ruleId, queryName, "ERROR: " + e.getMessage());
      }
      report.put(entry);
    }
  }

  /**
   * A missing backend oracle is a coverage result, not an invitation to borrow another backend's
   * expectation. Observation executes the query exactly once and records its raw behavior;
   * enforcement records the gap without executing or scoring the query.
   */
  private void recordMissingOracle(
      String ruleId,
      String queryName,
      String role,
      String query,
      int schemaVersion,
      List<String> failures,
      JSONArray report) {
    String reason =
        schemaVersion == 3
            ? "schema v3 provides only a standard backend oracle"
            : "schema v4 has no " + executionBackend.id + " entry in expected query backends";
    JSONObject entry =
        reportEntry(ruleId, queryName, role, query, "coverage-missing")
            .put("coverage", "missing")
            .put("reason", reason);

    if (!observeOnly) {
      entry.put("outcome", "coverage-missing");
      failures.add(
          "["
              + ruleId
              + "/"
              + queryName
              + "] missing "
              + executionBackend.id
              + " backend oracle: "
              + reason);
      report.put(entry);
      log(ruleId, queryName, "COVERAGE MISSING (" + executionBackend.id + ")");
      return;
    }

    try {
      BackendObservation obs = observeBackend(query);
      entry
          .put("rejected", obs.rejected)
          .put("observed", obs.toJson())
          .put("outcome", "coverage-missing");
      log(
          ruleId,
          queryName,
          "COVERAGE MISSING; OBSERVED (" + (obs.rejected ? "rejected" : "accepted") + ")");
    } catch (IOException | RuntimeException e) {
      entry.put("outcome", "error").put("error", String.valueOf(e.getMessage()));
      failures.add(
          "["
              + ruleId
              + "/"
              + queryName
              + "] backend observation failed: "
              + String.valueOf(e.getMessage()));
      log(ruleId, queryName, "ERROR: " + e.getMessage());
    }
    report.put(entry);
  }

  /**
   * Enforcement must establish complete backend-oracle coverage before executing any query in the
   * contract. This avoids producing partially scored evidence when a later query has no oracle.
   */
  private boolean recordEnforcementCoverageGaps(
      String ruleId,
      String index,
      JSONObject queries,
      JSONObject expectedQueries,
      int schemaVersion,
      List<String> failures,
      JSONArray report) {
    boolean missing = false;
    for (String queryName : queries.keySet()) {
      JSONObject expected = expectedQueries.getJSONObject(queryName);
      if (resolveBackendOracle(schemaVersion, expected) != null) {
        continue;
      }
      JSONObject queryDef = queries.getJSONObject(queryName);
      String role = queryDef.optString("role", "trigger");
      String query = queryDef.getString("query").replace("{{index}}", index);
      recordMissingOracle(ruleId, queryName, role, query, schemaVersion, failures, report);
      missing = true;
    }
    return missing;
  }

  /** Record an explicit schema-v4 non-applicable oracle without executing the query. */
  private void recordNotApplicable(
      String ruleId, String queryName, JSONObject backend, JSONObject entry, JSONArray report) {
    String reason = backend.getString("reason");
    entry
        .put("outcome", "not-applicable")
        .put("reason", reason)
        .put("owner", backend.getString("owner"))
        .put("issue", backend.getString("issue"));
    report.put(entry);
    log(ruleId, queryName, "NOT APPLICABLE (" + executionBackend.id + ")");
  }

  /**
   * Resolve the execution backend oracle without fallback. Schema v3 is standard-only; schema v4
   * requires an explicit entry in {@code backends}.
   */
  private JSONObject resolveBackendOracle(int schemaVersion, JSONObject expected) {
    if (schemaVersion == 3) {
      return executionBackend == ExecutionBackend.STANDARD
          ? expected.getJSONObject("backend")
          : null;
    }
    if (schemaVersion == 4) {
      JSONObject backends = expected.optJSONObject("backends");
      return backends != null && backends.has(executionBackend.id)
          ? backends.getJSONObject(executionBackend.id)
          : null;
    }
    throw new IllegalArgumentException("unsupported contract schemaVersion " + schemaVersion);
  }

  /**
   * Validate every expectation before version selection or query execution. Observation mode may
   * tolerate a missing route oracle, but it must never turn a malformed oracle into observed drift.
   */
  private boolean validateAllExpectations(
      String ruleId,
      JSONObject declaredQueries,
      JSONArray expectations,
      int schemaVersion,
      List<String> failures) {
    Set<String> declared = new LinkedHashSet<>(declaredQueries.keySet());
    boolean valid = true;
    if (declared.isEmpty()) {
      failures.add("[" + ruleId + "] queries must not be empty");
      valid = false;
    }
    for (int i = 0; i < expectations.length(); i++) {
      String expectationPath = "expectations[" + i + "]";
      Object expectationValue = expectations.opt(i);
      if (!(expectationValue instanceof JSONObject)) {
        failures.add("[" + ruleId + "] " + expectationPath + " must be an object");
        valid = false;
        continue;
      }
      JSONObject expectation = (JSONObject) expectationValue;
      Object expectationQueriesValue = expectation.opt("queries");
      if (!(expectationQueriesValue instanceof JSONObject)) {
        failures.add("[" + ruleId + "] " + expectationPath + ".queries must be an object");
        valid = false;
        continue;
      }
      JSONObject expectationQueries = (JSONObject) expectationQueriesValue;
      Set<String> expected = new LinkedHashSet<>(expectationQueries.keySet());
      if (!declared.equals(expected)) {
        Set<String> missingFromExpectation = new LinkedHashSet<>(declared);
        missingFromExpectation.removeAll(expected);
        Set<String> unknownInExpectation = new LinkedHashSet<>(expected);
        unknownInExpectation.removeAll(declared);
        failures.add(
            "["
                + ruleId
                + "] "
                + expectationPath
                + " query keys must exactly match top-level queries"
                + "; missing from expectation="
                + missingFromExpectation
                + "; unknown in expectation="
                + unknownInExpectation);
        valid = false;
      }

      for (String queryName : expected) {
        String queryPath = expectationPath + ".queries." + queryName;
        Object queryExpectationValue = expectationQueries.opt(queryName);
        if (!(queryExpectationValue instanceof JSONObject)) {
          failures.add("[" + ruleId + "] " + queryPath + " must be an object");
          valid = false;
          continue;
        }
        JSONObject queryExpectation = (JSONObject) queryExpectationValue;
        if (schemaVersion == 3) {
          Object backendValue = queryExpectation.opt("backend");
          if (!(backendValue instanceof JSONObject)) {
            failures.add(
                "[" + ruleId + "] " + queryPath + ".backend must be a schema-v3 oracle object");
            valid = false;
            continue;
          }
          valid &=
              validateBackendOracle(
                  ruleId, queryPath + ".backend", (JSONObject) backendValue, failures);
          continue;
        }

        if (!queryExpectation.has("backends")) {
          continue;
        }
        Object backendsValue = queryExpectation.opt("backends");
        if (!(backendsValue instanceof JSONObject)) {
          failures.add("[" + ruleId + "] " + queryPath + ".backends must be an object");
          valid = false;
          continue;
        }
        JSONObject backends = (JSONObject) backendsValue;
        for (String backend : backends.keySet()) {
          String backendPath = queryPath + ".backends." + backend;
          if (!"standard".equals(backend) && !"analytics".equals(backend)) {
            failures.add(
                "["
                    + ruleId
                    + "] "
                    + queryPath
                    + " declares unknown execution backend \""
                    + backend
                    + "\"");
            valid = false;
            continue;
          }
          Object oracleValue = backends.opt(backend);
          if (!(oracleValue instanceof JSONObject)) {
            failures.add("[" + ruleId + "] " + backendPath + " must be an oracle object");
            valid = false;
            continue;
          }
          valid &= validateBackendOracle(ruleId, backendPath, (JSONObject) oracleValue, failures);
        }
      }
    }
    return valid;
  }

  private boolean validateBackendOracle(
      String ruleId, String path, JSONObject oracle, List<String> failures) {
    int initialFailureCount = failures.size();
    String kind = requireNonBlankString(ruleId, path + ".kind", oracle.opt("kind"), failures);
    if (kind == null) {
      return false;
    }

    if ("not-applicable".equals(kind)) {
      requireNonBlankString(ruleId, path + ".reason", oracle.opt("reason"), failures);
      requireNonBlankString(ruleId, path + ".owner", oracle.opt("owner"), failures);
      requireNonBlankString(ruleId, path + ".issue", oracle.opt("issue"), failures);
      return failures.size() == initialFailureCount;
    }

    Integer httpStatus =
        requireInteger(ruleId, path + ".httpStatus", oracle.opt("httpStatus"), 100, 599, failures);
    switch (kind) {
      case "rejection":
        validateRejectionOracle(ruleId, path, oracle, httpStatus, failures);
        break;
      case "result-shape":
        requireHttpOk(ruleId, path, httpStatus, failures);
        validateResultShapeOracle(ruleId, path, oracle, failures);
        break;
      case "advisory":
        requireHttpOk(ruleId, path, httpStatus, failures);
        validateAdvisoryOracle(ruleId, path, oracle, failures);
        break;
      default:
        failures.add("[" + ruleId + "] " + path + ".kind is unknown: \"" + kind + "\"");
        break;
    }
    return failures.size() == initialFailureCount;
  }

  private void validateRejectionOracle(
      String ruleId, String path, JSONObject oracle, Integer httpStatus, List<String> failures) {
    Object bodyValue = oracle.opt("body");
    if (!(bodyValue instanceof JSONObject)) {
      failures.add("[" + ruleId + "] " + path + ".body must be an object");
      return;
    }
    JSONObject body = (JSONObject) bodyValue;
    Integer bodyStatus =
        requireInteger(ruleId, path + ".body.status", body.opt("status"), 100, 599, failures);
    if (httpStatus != null && bodyStatus != null && !httpStatus.equals(bodyStatus)) {
      failures.add("[" + ruleId + "] " + path + ".httpStatus must equal " + path + ".body.status");
    }

    if (!body.has("error")) {
      return;
    }
    Object errorValue = body.opt("error");
    if (!(errorValue instanceof JSONObject)) {
      failures.add("[" + ruleId + "] " + path + ".body.error must be an object");
      return;
    }
    JSONObject error = (JSONObject) errorValue;
    if (error.has("type")) {
      requireNonBlankString(ruleId, path + ".body.error.type", error.opt("type"), failures);
    }
    if (error.has("reason")) {
      requireNonBlankString(ruleId, path + ".body.error.reason", error.opt("reason"), failures);
    }
  }

  private void validateResultShapeOracle(
      String ruleId, String path, JSONObject oracle, List<String> failures) {
    if (!oracle.has("expect")) {
      return;
    }
    Object expectValue = oracle.opt("expect");
    if (!(expectValue instanceof JSONObject)) {
      failures.add("[" + ruleId + "] " + path + ".expect must be an object");
      return;
    }
    JSONObject expect = (JSONObject) expectValue;
    if (expect.has("datarowsNonEmpty") && !(expect.opt("datarowsNonEmpty") instanceof Boolean)) {
      failures.add("[" + ruleId + "] " + path + ".expect.datarowsNonEmpty must be a boolean");
    }
    if (expect.has("datarowsCount")) {
      requireInteger(
          ruleId,
          path + ".expect.datarowsCount",
          expect.opt("datarowsCount"),
          0,
          Integer.MAX_VALUE,
          failures);
    }
    if (expect.has("columnAllNull")) {
      requireNonBlankString(
          ruleId, path + ".expect.columnAllNull", expect.opt("columnAllNull"), failures);
    }
  }

  private void validateAdvisoryOracle(
      String ruleId, String path, JSONObject oracle, List<String> failures) {
    if (!oracle.has("expect")) {
      return;
    }
    Object expectValue = oracle.opt("expect");
    if (!(expectValue instanceof JSONObject)) {
      failures.add("[" + ruleId + "] " + path + ".expect must be an object");
      return;
    }
    JSONObject expect = (JSONObject) expectValue;
    if (expect.has("accepted") && !Boolean.TRUE.equals(expect.opt("accepted"))) {
      failures.add("[" + ruleId + "] " + path + ".expect.accepted must be true");
    }
  }

  private void requireHttpOk(
      String ruleId, String path, Integer httpStatus, List<String> failures) {
    if (httpStatus != null && httpStatus != 200) {
      failures.add("[" + ruleId + "] " + path + ".httpStatus must be 200");
    }
  }

  private String requireNonBlankString(
      String ruleId, String path, Object value, List<String> failures) {
    if (!(value instanceof String) || ((String) value).trim().isEmpty()) {
      failures.add("[" + ruleId + "] " + path + " must be a non-blank string");
      return null;
    }
    return (String) value;
  }

  private Integer requireInteger(
      String ruleId, String path, Object value, int minimum, int maximum, List<String> failures) {
    if (!(value instanceof Number)) {
      failures.add("[" + ruleId + "] " + path + " must be an integer");
      return null;
    }
    double numeric = ((Number) value).doubleValue();
    if (!Double.isFinite(numeric)
        || numeric != Math.rint(numeric)
        || numeric < minimum
        || numeric > maximum) {
      failures.add(
          "["
              + ruleId
              + "] "
              + path
              + " must be an integer from "
              + minimum
              + " through "
              + maximum);
      return null;
    }
    return ((Number) value).intValue();
  }

  /**
   * Find the expectations that apply to the candidate version and planner. The caller treats zero
   * matches as raw-observation-only and multiple matches as fatal in every mode.
   */
  private List<JSONObject> matchingExpectations(JSONArray expectations, boolean calciteOn) {
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
    return matches;
  }

  private String backendVersionLabel() {
    return engineVersionRaw == null ? "unknown" : engineVersionRaw;
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
        throw new IOException("failed to read rejection response body for query: " + query, ioe);
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
        o.put("body", body);
        JSONObject err = body.optJSONObject("error");
        if (err != null) {
          o.put("type", err.opt("type")).put("reason", err.opt("reason"));
        }
      }
      if (response != null) {
        o.put("response", response);
      }
      return o;
    }
  }

  // --- analytics route attestation ------------------------------------------

  /**
   * Prove the analytics route before any contract is scored. Each check is retained in the target
   * manifest, including failures, so a missing route cannot be mistaken for backend coverage.
   */
  private boolean attestAnalyticsRoute(List<String> failures) {
    boolean plugins =
        runAnalyticsAttestationCheck(
            "pluginsVerified", "required plugins", this::verifyAnalyticsPlugins, failures);
    boolean clusterSettings =
        runAnalyticsAttestationCheck(
            "clusterSettingsVerified",
            "cluster settings",
            this::verifyAnalyticsClusterSettings,
            failures);
    boolean fixtureIndices =
        runAnalyticsAttestationCheck(
            "fixtureIndicesVerified",
            "fixture index settings",
            this::verifyAnalyticsFixtureIndices,
            failures);
    boolean explain =
        runAnalyticsAttestationCheck(
            "explainVerified", "explain route", this::verifyAnalyticsExplainCanaries, failures);
    boolean profile =
        runAnalyticsAttestationCheck(
            "profiledExecutionVerified",
            "profiled execution",
            this::verifyAnalyticsProfileCanaries,
            failures);
    return plugins && clusterSettings && fixtureIndices && explain && profile;
  }

  private boolean runAnalyticsAttestationCheck(
      String targetField, String label, AttestationCheck check, List<String> failures) {
    try {
      check.run();
      analyticsRouteAttestation.put(targetField, true);
      log("route-attestation", label, "PASS");
      return true;
    } catch (Exception | AssertionError e) {
      analyticsRouteAttestation.put(targetField, false);
      failures.add(
          "[route-attestation/"
              + label
              + "] "
              + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
      log("route-attestation", label, "FAIL: " + e.getMessage());
      return false;
    }
  }

  private void verifyAnalyticsPlugins() throws IOException {
    Response response =
        client()
            .performRequest(new Request("GET", "/_cat/plugins?format=json&h=component,version"));
    JSONArray plugins = new JSONArray(getResponseBody(response, true));
    List<String> installed = new ArrayList<>();
    for (int i = 0; i < plugins.length(); i++) {
      installed.add(plugins.getJSONObject(i).getString("component"));
    }
    analyticsRouteAttestation.put("plugins", plugins);

    requireAttestation(
        engineVersionRaw != null && !engineVersionRaw.trim().isEmpty(),
        "cluster engine version is unavailable for plugin compatibility checks");
    String expectedVersionPrefix = engineVersionRaw.split("-")[0];
    for (String required : REQUIRED_ANALYTICS_PLUGIN_COMPONENTS) {
      JSONObject matched = null;
      for (int i = 0; i < plugins.length(); i++) {
        JSONObject plugin = plugins.getJSONObject(i);
        if (pluginComponentMatches(plugin.getString("component"), required)) {
          matched = plugin;
          break;
        }
      }
      requireAttestation(
          matched != null,
          "required plugin component matching \""
              + required
              + "\" is missing; installed="
              + installed);
      String version = matched.optString("version", "");
      requireAttestation(
          version.equals(expectedVersionPrefix)
              || version.startsWith(expectedVersionPrefix + ".")
              || version.startsWith(expectedVersionPrefix + "-"),
          "plugin "
              + matched.getString("component")
              + " version "
              + version
              + " is incompatible with engine "
              + engineVersionRaw);
    }
  }

  private boolean pluginComponentMatches(String component, String required) {
    return component.equals(required) || component.endsWith("-" + required);
  }

  private void verifyAnalyticsClusterSettings() throws IOException {
    Response nodesResponse =
        client().performRequest(new Request("GET", "/_nodes/settings?flat_settings=true"));
    JSONObject nodesBody = new JSONObject(getResponseBody(nodesResponse, true));
    analyticsRouteAttestation.put("nodeSettings", nodesBody);
    JSONObject nodes = nodesBody.getJSONObject("nodes");
    requireAttestation(nodes.length() > 0, "node settings response contained no nodes");
    for (String nodeId : nodes.keySet()) {
      String startupDataFormat =
          nodes
              .getJSONObject(nodeId)
              .getJSONObject("settings")
              .optString("cluster.pluggable.dataformat", "");
      String startupEnabled =
          nodes
              .getJSONObject(nodeId)
              .getJSONObject("settings")
              .optString("cluster.pluggable.dataformat.enabled", "");
      requireAttestation(
          "composite".equals(startupDataFormat),
          "node "
              + nodeId
              + " startup cluster.pluggable.dataformat must be composite but was \""
              + startupDataFormat
              + "\"");
      requireAttestation(
          "true".equals(startupEnabled),
          "node "
              + nodeId
              + " startup cluster.pluggable.dataformat.enabled must be true but was \""
              + startupEnabled
              + "\"");
    }

    Response response =
        client()
            .performRequest(
                new Request("GET", "/_cluster/settings?flat_settings=true&include_defaults=true"));
    JSONObject settings = new JSONObject(getResponseBody(response, true));
    analyticsRouteAttestation.put("clusterSettings", settings);

    requireEffectiveSetting(settings, "cluster.pluggable.dataformat", "composite");
    requireEffectiveSetting(settings, "cluster.pluggable.dataformat.enabled", "true");
    requireEffectiveSetting(settings, "cluster.composite.primary_data_format", "parquet");
    requireEffectiveSettingContains(settings, "cluster.composite.secondary_data_formats", "lucene");
  }

  private void verifyAnalyticsFixtureIndices() throws IOException {
    int expectedShards = analyticsShardCount();
    JSONObject documentCounts = new JSONObject();
    JSONObject fixtureIndices = new JSONObject();
    analyticsRouteAttestation
        .put("fixtureDocumentCounts", documentCounts)
        .put("fixtureIndices", fixtureIndices);
    for (String indexEnum : requiredIndexEnums()) {
      String indexName = Index.valueOf(indexEnum).getName();
      Response response =
          client()
              .performRequest(
                  new Request(
                      "GET",
                      "/" + indexName + "/_settings?flat_settings=true&include_defaults=true"));
      JSONObject body = new JSONObject(getResponseBody(response, true));
      JSONObject settings = body.getJSONObject(indexName).getJSONObject("settings");
      JSONObject fixtureEvidence = new JSONObject().put("settings", settings);
      fixtureIndices.put(indexName, fixtureEvidence);

      Response mappingResponse =
          client().performRequest(new Request("GET", "/" + indexName + "/_mapping"));
      JSONObject mappingBody = new JSONObject(getResponseBody(mappingResponse, true));
      JSONObject mapping = mappingBody.getJSONObject(indexName).getJSONObject("mappings");
      fixtureEvidence.put("mappingHash", sha256(canonicalJson(mapping))).put("mapping", mapping);

      requireIndexSetting(indexName, settings, "index.pluggable.dataformat.enabled", "true");
      requireIndexSetting(indexName, settings, "index.pluggable.dataformat", "composite");
      requireIndexSetting(indexName, settings, "index.composite.primary_data_format", "parquet");
      requireIndexSettingContains(
          indexName, settings, "index.composite.secondary_data_formats", "lucene");
      requireIndexSetting(
          indexName, settings, "index.number_of_shards", Integer.toString(expectedShards));

      long count = analyticsDocumentCount(indexName);
      documentCounts.put(indexName, count);
      fixtureEvidence.put("documentCount", count);
      requireAttestation(
          count > 0,
          "fixture " + indexName + " contains no documents; fixture ingestion did not complete");
    }
  }

  private long analyticsDocumentCount(String indexName) throws IOException {
    JSONObject response =
        executeQuery("source=" + indexName + " | stats count() as document_count");
    JSONArray rows = response.getJSONArray("datarows");
    requireAttestation(rows.length() == 1, "fixture " + indexName + " count returned " + rows);
    JSONArray row = rows.getJSONArray(0);
    requireAttestation(
        row.length() == 1 && row.get(0) instanceof Number,
        "fixture " + indexName + " count did not return one numeric value: " + rows);
    return ((Number) row.get(0)).longValue();
  }

  private String canonicalJson(Object value) {
    if (value == null || value == JSONObject.NULL) {
      return "null";
    }
    if (value instanceof JSONObject) {
      JSONObject object = (JSONObject) value;
      List<String> keys = new ArrayList<>(object.keySet());
      Collections.sort(keys);
      StringBuilder canonical = new StringBuilder("{");
      for (int i = 0; i < keys.size(); i++) {
        if (i > 0) {
          canonical.append(',');
        }
        String key = keys.get(i);
        canonical.append(JSONObject.quote(key)).append(':').append(canonicalJson(object.get(key)));
      }
      return canonical.append('}').toString();
    }
    if (value instanceof JSONArray) {
      JSONArray array = (JSONArray) value;
      StringBuilder canonical = new StringBuilder("[");
      for (int i = 0; i < array.length(); i++) {
        if (i > 0) {
          canonical.append(',');
        }
        canonical.append(canonicalJson(array.get(i)));
      }
      return canonical.append(']').toString();
    }
    if (value instanceof String) {
      return JSONObject.quote((String) value);
    }
    if (value instanceof Number || value instanceof Boolean) {
      return value.toString();
    }
    throw new IllegalArgumentException(
        "unsupported JSON value type in fixture mapping: " + value.getClass().getName());
  }

  private String sha256(String value) {
    try {
      byte[] digest =
          MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder hex = new StringBuilder("sha256:");
      for (byte octet : digest) {
        hex.append(String.format(Locale.ROOT, "%02x", octet & 0xff));
      }
      return hex.toString();
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 digest is unavailable", e);
    }
  }

  private void verifyAnalyticsExplainCanaries() throws IOException {
    JSONObject explainPlans = new JSONObject();
    analyticsRouteAttestation.put("explainPlans", explainPlans);
    for (String indexEnum : requiredIndexEnums()) {
      String query = analyticsCanaryQuery(indexEnum);
      String explained = explainQueryToString(query);
      explainPlans.put(indexEnum, explained);
      requireAttestation(
          explained.contains("LogicalTableScan(table=[[opensearch,"),
          "fixture " + indexEnum + " did not use LogicalTableScan(opensearch): " + explained);
      requireAttestation(
          !explained.contains("CalciteLogicalIndexScan"),
          "fixture " + indexEnum + " fell back to CalciteLogicalIndexScan: " + explained);
    }
  }

  private void verifyAnalyticsProfileCanaries() throws IOException {
    JSONArray executionTypes = new JSONArray();
    JSONObject profiles = new JSONObject();
    analyticsRouteAttestation
        .put("profileExecutionTypes", executionTypes)
        .put("profiles", profiles);
    for (String indexEnum : requiredIndexEnums()) {
      JSONObject response = runProfiledPplQuery(analyticsCanaryQuery(indexEnum));
      profiles.put(indexEnum, response);
      JSONObject profile = response.getJSONObject("profile");
      JSONArray stages = profile.getJSONObject("plan").getJSONArray("stages");
      requireAttestation(
          stages.length() > 0, "fixture " + indexEnum + " profile returned no execution stages");
      for (int i = 0; i < stages.length(); i++) {
        JSONObject stage = stages.getJSONObject(i);
        requireAttestation(
            "SUCCEEDED".equals(stage.optString("state")),
            "fixture " + indexEnum + " profile stage " + i + " was not successful: " + stage);
        requireAttestation(
            !stage.optString("execution_type", "").trim().isEmpty(),
            "fixture " + indexEnum + " profile stage " + i + " has no execution_type: " + stage);
        executionTypes.put(stage.getString("execution_type"));
      }
    }
  }

  private String analyticsCanaryQuery(String indexEnum) {
    String indexName = Index.valueOf(indexEnum).getName();
    switch (indexEnum) {
      case "ACCOUNT":
        return "source=" + indexName + " | fields account_number, firstname | head 1";
      case "FLAT_OBJECT":
        return "source=" + indexName + " | fields name, status | head 1";
      default:
        throw new IllegalArgumentException(
            "no fixture-safe analytics canary projection is defined for " + indexEnum);
    }
  }

  private JSONObject runProfiledPplQuery(String query) throws IOException {
    Request request = new Request("POST", QUERY_API_ENDPOINT);
    request.setJsonEntity(new JSONObject().put("query", query).put("profile", true).toString());
    RequestOptions.Builder options = RequestOptions.DEFAULT.toBuilder();
    options.addHeader("Content-Type", "application/json");
    request.setOptions(options);

    Response response = client().performRequest(request);
    assertEquals(200, response.getStatusLine().getStatusCode());
    return new JSONObject(getResponseBody(response, true));
  }

  private void requireEffectiveSetting(JSONObject settings, String key, String expected) {
    String actual = effectiveSetting(settings, key);
    requireAttestation(
        expected.equals(actual),
        "effective " + key + " must be " + expected + " but was \"" + actual + "\"");
  }

  private void requireEffectiveSettingContains(JSONObject settings, String key, String expected) {
    String actual = effectiveSetting(settings, key);
    requireAttestation(
        actual.contains(expected),
        "effective " + key + " must contain " + expected + " but was \"" + actual + "\"");
  }

  private String effectiveSetting(JSONObject settings, String key) {
    String transientValue = settingInSection(settings, "transient", key);
    if (!transientValue.isEmpty()) {
      return transientValue;
    }
    String persistentValue = settingInSection(settings, "persistent", key);
    if (!persistentValue.isEmpty()) {
      return persistentValue;
    }
    return settingInSection(settings, "defaults", key);
  }

  private String settingInSection(JSONObject settings, String section, String key) {
    JSONObject values = settings.optJSONObject(section);
    return values == null ? "" : values.optString(key, "");
  }

  private void requireIndexSetting(
      String indexName, JSONObject settings, String key, String expected) {
    String actual = settings.optString(key, "");
    requireAttestation(
        expected.equals(actual),
        "fixture "
            + indexName
            + " setting "
            + key
            + " must be "
            + expected
            + " but was \""
            + actual
            + "\"");
  }

  private void requireIndexSettingContains(
      String indexName, JSONObject settings, String key, String expected) {
    String actual = settings.optString(key, "");
    requireAttestation(
        actual.contains(expected),
        "fixture "
            + indexName
            + " setting "
            + key
            + " must contain "
            + expected
            + " but was \""
            + actual
            + "\"");
  }

  private int analyticsShardCount() {
    int shardCount = Integer.parseInt(System.getProperty(ANALYTICS_SHARD_COUNT_PROPERTY, "1"));
    requireAttestation(shardCount > 0, ANALYTICS_SHARD_COUNT_PROPERTY + " must be positive");
    return shardCount;
  }

  private static void requireAttestation(boolean condition, String message) {
    if (!condition) {
      throw new IllegalStateException(message);
    }
  }

  @FunctionalInterface
  private interface AttestationCheck {
    void run() throws Exception;
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
    String grammarHash = "";
    String bundleName = "";
    try {
      Response response = client().performRequest(new Request("GET", GRAMMAR_API_ENDPOINT));
      String bundleBody = getResponseBody(response, true);
      JSONObject bundle = new JSONObject(bundleBody);
      grammarHash = bundle.optString("grammarHash", "");
      Files.write(Paths.get(bundlePath), bundleBody.getBytes(StandardCharsets.UTF_8));
      bundleName = Paths.get(bundlePath).getFileName().toString();
      log("_grammar", "export", "wrote candidate bundle (" + grammarHash + ") to " + bundlePath);
    } catch (Exception e) {
      failures.add(
          "[grammar-export] failed to fetch/write " + GRAMMAR_API_ENDPOINT + ": " + e.getMessage());
    } finally {
      // Route and attestation identity remain available even when the grammar
      // endpoint or bundle write fails.
      writeTargetManifest(grammarHash, bundleName, failures);
    }
  }

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
   * Write target schema v2 with engine, grammar, execution route, storage, shard count, and (for
   * analytics) route attestation identity.
   */
  private void writeTargetManifest(String grammarHash, String bundleName, List<String> failures) {
    String targetPath = System.getProperty("ppl.lint.target");
    if (targetPath == null || targetPath.isEmpty()) {
      return;
    }
    try {
      JSONObject target =
          new JSONObject()
              .put("schemaVersion", 2)
              .put("sqlSha", System.getProperty("ppl.lint.sql_sha", ""))
              .put("engineVersion", engineVersionRaw == null ? "" : engineVersionRaw)
              .put("grammarHash", grammarHash)
              .put("grammarBundle", bundleName)
              .put("executionBackend", executionBackend.id)
              .put("storage", executionBackend.storage)
              .put(
                  "shardCount",
                  executionBackend == ExecutionBackend.ANALYTICS ? analyticsShardCount() : 1);
      if (executionBackend == ExecutionBackend.ANALYTICS) {
        target
            .put(
                "analyticsStack",
                new JSONObject()
                    .put("source", System.getProperty("ppl.lint.analytics.stack.source", "")))
            .put("routeAttestation", analyticsRouteAttestation);
      }
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
    Set<String> ruleIds = new LinkedHashSet<>();
    for (String fileName : manifestContractNames()) {
      JSONObject contract = loadContractFile(CONTRACT_DIR + "/" + fileName);
      String ruleId = contract.getString("ruleId");
      if (!ruleIds.add(ruleId)) {
        throw new IOException("contract manifest contains duplicate ruleId \"" + ruleId + "\"");
      }
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
    Set<String> unique = new LinkedHashSet<>();
    for (int i = 0; i < contracts.length(); i++) {
      String name = contracts.getString(i);
      if (!unique.add(name)) {
        throw new IOException("contract manifest contains duplicate file \"" + name + "\"");
      }
      names.add(name);
    }
    return names;
  }

  /**
   * Union of index enums required by the contracts scheduled to run this session.
   *
   * <p>A schema-v4 contract whose selected analytics oracle marks every query explicitly
   * non-applicable does not need its unrepresentable fixture. Missing or malformed oracles remain
   * fixture-requiring so they cannot turn into an implicit skip.
   */
  private Set<String> requiredIndexEnums() throws IOException {
    Set<String> indices = new LinkedHashSet<>();
    for (JSONObject contract : loadScheduledContracts()) {
      if (!contractRequiresFixture(contract)) {
        continue;
      }
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

  private boolean contractRequiresFixture(JSONObject contract) {
    if (executionBackend != ExecutionBackend.ANALYTICS || contract.optInt("schemaVersion") != 4) {
      return true;
    }

    JSONObject fixture = contract.optJSONObject("backendFixture");
    List<JSONObject> matches =
        matchingExpectations(contract.getJSONArray("expectations"), fixtureCalciteEnabled(fixture));
    if (matches.size() != 1) {
      return true;
    }

    JSONObject declaredQueries = contract.optJSONObject("queries");
    JSONObject expectedQueries = matches.get(0).optJSONObject("queries");
    if (declaredQueries == null
        || declaredQueries.length() == 0
        || expectedQueries == null
        || !declaredQueries.keySet().equals(expectedQueries.keySet())) {
      return true;
    }

    for (String queryName : declaredQueries.keySet()) {
      JSONObject expected = expectedQueries.optJSONObject(queryName);
      JSONObject backend = expected == null ? null : resolveBackendOracle(4, expected);
      if (!isCompleteNotApplicableOracle(backend)) {
        return true;
      }
    }
    return false;
  }

  private boolean isCompleteNotApplicableOracle(JSONObject backend) {
    return backend != null
        && "not-applicable".equals(backend.optString("kind"))
        && hasNonBlankString(backend, "reason")
        && hasNonBlankString(backend, "owner")
        && hasNonBlankString(backend, "issue");
  }

  private boolean hasNonBlankString(JSONObject object, String key) {
    Object value = object.opt(key);
    return value instanceof String && !((String) value).trim().isEmpty();
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
        .put("kind", kind)
        .put("executionBackend", executionBackend.id);
  }

  private void writeReport(JSONArray report) throws IOException {
    String target = System.getProperty("ppl.lint.report");
    if (target == null || target.isEmpty()) {
      return;
    }
    Files.write(Paths.get(target), report.toString(2).getBytes(StandardCharsets.UTF_8));
  }

  private void log(String ruleId, String caseId, String message) {
    System.out.println(
        String.format(
            Locale.ROOT, "[ppl-lint-backend-contract] %s/%s: %s", ruleId, caseId, message));
  }

  private enum ExecutionBackend {
    STANDARD("standard", "lucene"),
    ANALYTICS("analytics", "composite-parquet");

    private final String id;
    private final String storage;

    ExecutionBackend(String id, String storage) {
      this.id = id;
      this.storage = storage;
    }

    private static ExecutionBackend parse(String value) {
      for (ExecutionBackend backend : values()) {
        if (backend.id.equals(value)) {
          return backend;
        }
      }
      throw new IllegalArgumentException(
          EXECUTION_BACKEND_PROPERTY + " must be standard or analytics but was \"" + value + "\"");
    }
  }
}
