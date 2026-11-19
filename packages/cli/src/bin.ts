#!/usr/bin/env node
/**
 * The achi command. The bundled file (dist/achi.js) also runs the motif
 * scan when started as a worker thread (@achi/node/motifThreads), so the
 * command stays one file.
 */
import { isMotifWorker, runMotifWorker } from "@achi/node/motifThreads";
import { main } from "./cli";

if (isMotifWorker()) runMotifWorker();
else
  main(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), env: process.env }, { motifWorker: new URL(import.meta.url) }).then((code) => {
    process.exitCode = code;
  });
