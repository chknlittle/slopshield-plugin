import assert from "node:assert/strict";
import test from "node:test";

import { executeInterpreter } from "../src/execute-interpreter.js";

function createDocument({ nonce = "" } = {}) {
  const events = [];
  const script = {
    remove() {
      events.push("remove");
    },
  };
  const parent = {
    appendChild(node) {
      events.push(["append", node]);
    },
  };

  return {
    document: {
      createElement(tagName) {
        assert.equal(tagName, "script");
        return script;
      },
      querySelector(selector) {
        assert.equal(selector, "script[nonce]");
        return nonce ? { nonce } : null;
      },
      head: parent,
      documentElement: parent,
    },
    events,
    script,
  };
}

test("assigns the interpreter directly to the Trusted Types script sink", () => {
  const trustedScript = { trusted: true };
  const fixture = createDocument({ nonce: "youtube-nonce" });

  executeInterpreter(fixture.document, trustedScript);

  assert.strictEqual(fixture.script.text, trustedScript);
  assert.equal(fixture.script.type, "text/javascript");
  assert.equal(fixture.script.nonce, "youtube-nonce");
  assert.deepEqual(fixture.events, [["append", fixture.script], "remove"]);
});

test("removes the script when execution throws", () => {
  const fixture = createDocument();
  fixture.document.head.appendChild = () => {
    throw new Error("blocked");
  };

  assert.throws(() => executeInterpreter(fixture.document, "source"), /blocked/);
  assert.deepEqual(fixture.events, ["remove"]);
});
