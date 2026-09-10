import {it,expect} from "vitest";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";

it("starts only the service coordinator when imported CLIs are bundled together",async()=>{
 const root=mkdtempSync(join(tmpdir(),"pc-service-bundle-"));
 try {
  const outfile=join(root,"run-termix-service.mjs");
  await build({entryPoints:[resolve("src/cli/run-termix-service.ts")],outfile,bundle:true,platform:"node",format:"esm",target:"node22"});
  // No credentials or network: the intended coordinator must reject immediately.
  // Imported watcher/delivery entrypoints must not launch or print their failures.
  const result=spawnSync(process.execPath,[outfile],{env:{},encoding:"utf8",timeout:15000});
  expect(result.status).toBe(1);expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n").map(line=>JSON.parse(line).event)).toEqual(["service.failed"]);
 } finally {rmSync(root,{recursive:true,force:true});}
});
