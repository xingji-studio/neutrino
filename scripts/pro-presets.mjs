// Nothing ships with the package any more: the Pro presets live at
// https://ius.neutrino.xingjisoft.com/model.json, so every test that opens the
// Pro workspace writes its own copy into the throwaway HOME it runs in.
import fs from "node:fs";
import path from "node:path";
import { PRO_MODEL_FILE, PRO_ROLES } from "../dist/pro/config.js";

/** A complete, valid preset tier list: one entry per role, all pointing at one provider. */
export function proPresets(names = ["medium"], provider = "Fixture") {
  return names.map((name) => ({
    name,
    chinese_name: name,
    "model-setting": PRO_ROLES.map((type) => ({
      type,
      provider,
      model: type === "genimage_model" ? null : "fixture-model",
      intensity: "xhigh",
      context_window: 272000,
    })),
  }));
}

/** Write `model.json` (or another presets file) for the current test home. */
export function seedProPresets(names = ["medium"], file = PRO_MODEL_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tier: proPresets(names) }, null, 2));
}
