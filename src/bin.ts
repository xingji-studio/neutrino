#!/usr/bin/env node
import process from "node:process";
import { App } from "./app.js";

if (!process.stdout.isTTY || !process.stdin.isTTY) {
  process.stderr.write("neutrino requires an interactive terminal.\n");
  process.exit(1);
}

const app = new App();
await app.start();
