/*
 * Nuskomate release builder
 * -------------------------
 *  - Copies the extension into dist/
 *  - Obfuscates every .js file (safe settings for an MV3 content-script extension)
 *  - Zips dist/ into releases/nuskomate-<version>.zip
 *
 *  Run with:  npm run build
 */

const fs   = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");
const archiver = require("archiver");

const ROOT     = __dirname;
const DIST     = path.join(ROOT, "dist");
const RELEASES = path.join(ROOT, "releases");

// --raw / --no-obfuscate → ship readable source (zip suffixed "-raw")
const RAW = process.argv.includes("--raw") || process.argv.includes("--no-obfuscate");

// Files / folders never included in the build
const EXCLUDE = new Set([
  "node_modules", "dist", "releases", "server", ".git", ".github", ".claude",
  "build.js", "package.json", "package-lock.json",
  "README.md", "LICENSE", "RELEASE_NOTES.md", ".gitignore", "smoke.js",
  "logo.png", // branding asset — not used by the extension itself
]);

// Files shipped as harmless stubs in OBFUSCATED (release) builds only.
// The real passport parser lives on the license server, so the valuable
// logic is never distributed to customers. window.NkPassport still exists
// (no-op) so script tags / references never break.
const STUB_FILES = new Set(["passport-parser.js"]);
const PARSER_STUB =
  "/* Parsing runs on the Nuskomate license server. This stub ships in licensed builds. */\n" +
  "(function(){var s={parse:function(){return{details:{},nameBoxes:{},mrzValid:false,blurry:false};}};" +
  "if(typeof window!==\"undefined\")window.NkPassport=s;" +
  "if(typeof module!==\"undefined\"&&module.exports)module.exports=s;})();\n";

// Obfuscator settings — tuned to NOT break the extension:
//  • renameGlobals/renameProperties OFF  → cross-file window.* globals
//    (window.nkLog, window.simulateAngularInput, sharedDropdownHandler…) stay intact
//  • no eval / Function / debugProtection → stays within MV3's strict CSP
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.7,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  numbersToExpressions: true,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 8,
  identifierNamesGenerator: "hexadecimal",
  transformObjectKeys: true,
  renameGlobals: false,
  renameProperties: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
};

function rimraf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function walk(dir, baseRel = "") {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (EXCLUDE.has(name)) continue;
    const abs = path.join(dir, name);
    const rel = path.join(baseRel, name);
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

function build() {
  rimraf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  const files = walk(ROOT);
  let jsCount = 0, copyCount = 0;

  for (const rel of files) {
    const src  = path.join(ROOT, rel);
    const dest = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (rel.endsWith(".js")) {
      // Replace protected files with a stub in real (obfuscated) releases.
      if (!RAW && STUB_FILES.has(path.basename(rel))) {
        fs.writeFileSync(dest, PARSER_STUB);
        jsCount++;
        continue;
      }
      const code = fs.readFileSync(src, "utf8");
      if (RAW || code.trim() === "") {
        fs.writeFileSync(dest, code);           // ship source as-is
      } else {
        const result = JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_OPTIONS);
        fs.writeFileSync(dest, result.getObfuscatedCode());
      }
      jsCount++;
    } else {
      fs.copyFileSync(src, dest);
      copyCount++;
    }
  }

  console.log(`${RAW ? "Copied (raw)" : "Obfuscated"} ${jsCount} JS files, copied ${copyCount} assets → dist/`);
  return zipDist();
}

function zipDist() {
  // Read version from the manifest so the zip name tracks releases
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  const zipName  = `nuskomate-v${manifest.version}${RAW ? "-raw" : ""}.zip`;

  fs.mkdirSync(RELEASES, { recursive: true });
  const zipPath = path.join(RELEASES, zipName);
  rimraf(zipPath);

  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      console.log(`Packaged ${(archive.pointer() / 1024).toFixed(1)} KB → releases/${zipName}`);
      resolve();
    });
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(DIST + path.sep, false); // zip CONTENTS of dist (no top folder)
    archive.finalize();
  });
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
