import assert from "node:assert/strict";
import test from "node:test";
import { compileCifsForward } from "../src/route.ts";
import type { RouteSpec } from "../src/types.ts";

function spec(route: RouteSpec["route"]): RouteSpec {
  return { route, cwd: "/" };
}

test("flattenable jump listens on the final host", () => {
  const launch = compileCifsForward(spec([
    { type: "ssh", host: "jump" },
    { type: "ssh", host: "final", user: "root" },
  ]));
  assert.equal(launch.args.at(-1), "root@final");
  assert.equal(launch.args[launch.args.indexOf("-R") + 1], "127.0.0.1:0:127.0.0.1:445");
  assert.ok(launch.args.includes("LogLevel=INFO"));
  assert.ok(launch.args.includes("ExitOnForwardFailure=yes"));
  const jump = launch.args[launch.args.indexOf("-J") + 1];
  assert.match(jump, /jump/);
  assert.equal(launch.args.includes("ProxyCommand="), false);
});

test("non-flattenable hop still forwards from the final host", () => {
  const launch = compileCifsForward(spec([
    { type: "ssh", host: "jump", identityFile: "C:/keys/id" },
    { type: "ssh", host: "final" },
  ]));
  assert.equal(launch.args.at(-1), "final");
  const proxy = launch.args.find((arg) => arg.startsWith("ProxyCommand="));
  assert.ok(proxy);
  assert.match(proxy, /jump/);
  assert.match(proxy, /C:\/keys\/id/);
  assert.equal(launch.args.includes("-J"), false);
});

test("docker route is refused", () => {
  assert.throws(
    () => compileCifsForward(spec([{ type: "docker", container: "box" }])),
    /Docker/,
  );
});
