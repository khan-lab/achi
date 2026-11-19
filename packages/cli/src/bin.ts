#!/usr/bin/env node
import { main } from "./cli";

main(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), env: process.env }).then((code) => {
  process.exitCode = code;
});
