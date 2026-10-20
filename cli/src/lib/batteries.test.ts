import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertRequiredExperiment } from "./batteries";

const REQUIRED = "release-smoke.v1";

describe("apply --require-experiment", () => {
  it("accepts the required label inherited by every target", () => {
    assert.doesNotThrow(() =>
      assertRequiredExperiment(
        {
          version: 1,
          experiment: REQUIRED,
          prompts: [
            { key: "implicit", text: "one" },
            {
              key: "explicit",
              text: "two",
              schedules: [{}, { experiment: REQUIRED }],
            },
          ],
        },
        REQUIRED,
      ),
    );
  });

  it("rejects an absent or overridden marker before an API request", () => {
    assert.throws(
      () =>
        assertRequiredExperiment(
          {
            version: 1,
            prompts: [
              { key: "missing", text: "one" },
              {
                key: "overridden",
                text: "two",
                experiment: REQUIRED,
                schedules: [{ experiment: "other" }],
              },
            ],
          },
          REQUIRED,
        ),
      /prompts\.0\.schedules\.0, prompts\.1\.schedules\.0/,
    );
  });

  it("rejects an empty required label", () => {
    assert.throws(
      () =>
        assertRequiredExperiment(
          { version: 1, prompts: [{ key: "one", text: "one" }] },
          "",
        ),
      /requires a nonempty label/,
    );
  });
});
