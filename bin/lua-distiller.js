#!/usr/bin/env node

const pkg = require("../package");
const p = require("commander");
const fs = require("fs");
const path = require("path");
const _ = require("underscore");
require("shelljs/global");
const debuglog = require('debug')('distill');

p.version(pkg.version)
  .option('-o, --output [VALUE]', 'output directory')
  .option('-i, --input [VALUE]', 'path to main entrance coffee file')
  .option('-x, --excludes [VALUE]', 'package names to be excluded, separated by: ","')
  .option('-m, --minify', 'minify merged lua file by LuaSrcDiet')
  .option('-j, --luajitify', 'compile merged lua file into luajit binary')
  .parse(process.argv);

const EXTNAME = ".lua";
const COMMENT_MARK = "--";
let BASE_FILE_PATH = "";
const HR = "\n\n---------------------------------------\n\n\n";
const DISTILLER_HEAD = fs.readFileSync(`${__dirname}/distill_head.lua`)
let EXCLUDE_PACKAGE_NAMES = [];//"cjson zlib pack socket lfs lsqlite3 Cocos2d Cocos2dConstants".split(" ");

const RE_REQUIRE = /^.*require[\(\ ][\'"]([a-zA-Z0-9\.\_\/\-]+)[\'"]/mg;
let OUTPUT_PATH_MERGED_LUA = "";
let OUTPUT_PATH_MINIFIED_LUA = "";
let OUTPUT_PATH_MERGED_JIT = "";
let OUTPUT_PATH_MINIFIED_JIT = "";

const PATH_TO_LUA_SRC_DIET = path.resolve(__dirname, "../luasrcdiet/");
const PATH_TO_LUA_JIT = which("luajit");
const MODULES = {};
const VISITED_PATH = {};

function quitWithError (msg) {
  console.error("ERROR: " + msg);
  return process.exit(1);
};

function scan (filename, requiredBy) {
  requiredBy || (requiredBy = p.input);
  debuglog("scan: " + filename + ", required by:" + requiredBy);
  if (!fs.existsSync(filename)) {
    quitWithError("missing file at " + filename + ", required by:" + requiredBy);
  }
  let code = fs.readFileSync(filename, {
    encoding: 'utf8'
  });
  let requires = [];
  let processedCode = code.replace(RE_REQUIRE, function (line, packageName, indexFrom, whole) {
    console.log('PACKAGENAME',packageName);
    if ((packageName != null) &&
      !VISITED_PATH[filename + "->" + packageName] &&
      !~EXCLUDE_PACKAGE_NAMES.indexOf(packageName) &&
      (!~line.indexOf(COMMENT_MARK) &&
        line.indexOf(COMMENT_MARK) < line.indexOf('require'))) {

      console.log("[lua-distiller] require " + packageName + " in " + filename);
      requires.push(packageName);
      VISITED_PATH[filename + "->" + packageName] = true;
      return line;
    } else {
      console.log("[lua-distiller] ignore " + packageName + " in " + filename);
      return line;
    }
  });
  for (let i = 0, len = requires.length; i < len; i++) {
    let module = requires[i];
    if (MODULES[module]) {
      continue;
    }
    let pathToModuleFile = (module.replace(/\./g, '/')) + ".lua";
    pathToModuleFile = path.normalize(path.join(BASE_FILE_PATH, pathToModuleFile));
    MODULES[module] = scan(pathToModuleFile, filename);
  }
  return processedCode;
};

if (p.input == null) {
  quitWithError("missing main entrance lua file (-i), use -h for help.");
}

p.input = path.resolve(process.cwd(), p.input || '');

if (!(fs.existsSync(p.input) && path.extname(p.input) === EXTNAME)) {
  quitWithError("bad main entrance file: " + p.input + ", " + (path.extname(p.input)) + ".");
}

BASE_FILE_PATH = path.dirname(p.input);

if (p.excludes) {
  EXCLUDE_PACKAGE_NAMES = EXCLUDE_PACKAGE_NAMES.concat(p.excludes.split(",").map(function (item) {
    return item.trim();
  }));
}

p.output = path.resolve(process.cwd(), p.output || '');

if (path.extname(p.output)) {
  OUTPUT_PATH_MERGED_LUA = path.resolve(process.cwd(), p.output);
  OUTPUT_PATH_MINIFIED_LUA = path.resolve(process.cwd(), p.output + ".min.lua");
} else {
  let outputBasename = path.basename(p.output || p.input, '.lua');
  OUTPUT_PATH_MERGED_LUA = path.join(p.output, outputBasename + ".merged.lua");
  OUTPUT_PATH_MINIFIED_LUA = path.join(p.output, outputBasename + ".min.lua");
}

OUTPUT_PATH_MERGED_JIT = OUTPUT_PATH_MERGED_LUA + "jit";
OUTPUT_PATH_MINIFIED_JIT = OUTPUT_PATH_MINIFIED_LUA + "jit";

mkdir('-p', path.dirname(OUTPUT_PATH_MERGED_LUA));

console.log("lua-distiller v" + pkg.version);
console.log("merge from " + (path.relative(process.cwd(), p.input)) + " to " + (path.relative(process.cwd(), OUTPUT_PATH_MERGED_LUA)));
console.log("ignore package: " + EXCLUDE_PACKAGE_NAMES);
console.log("scanning...");

let entranceName = (path.basename(p.input)) + "_distilled";

MODULES[entranceName] = scan(p.input);

console.log("following modules have been scanned");
console.dir(_.keys(MODULES));
console.log("scan complete, generate output to: " + OUTPUT_PATH_MERGED_LUA);

let result = "-- Generated by node-lua-distiller(version: " + pkg.version + ")  at " + (new Date);
result += HR;
result += DISTILLER_HEAD;

EXCLUDE_PACKAGE_NAMES.forEach((packageName) => {
  result += "__DISTILLER:define(\"" + packageName + "\",function(require)" +
    "return __DISTILLER.__nativeRequire(\"" + packageName + "\")" +
    "end)\n";
});

for (let moduleId in MODULES) {
  let content = MODULES[moduleId];
  result += "__DISTILLER:define(\"" + moduleId + "\", function(require)\n" + content + "\nend)\n\n" + HR;
}

result += "return __DISTILLER:exec(\"" + entranceName + "\")";

fs.writeFileSync(OUTPUT_PATH_MERGED_LUA, result);

if (p.minify) {
  console.log("minify merged lua file to: " + OUTPUT_PATH_MINIFIED_LUA);
  exec("cd " + PATH_TO_LUA_SRC_DIET + " && ./LuaSrcDiet.lua " + OUTPUT_PATH_MERGED_LUA + " -o " + OUTPUT_PATH_MINIFIED_LUA + " ");
}

if (p.luajitify) {
  console.log("luajit compile merged lua file to " + OUTPUT_PATH_MERGED_JIT);
  exec(PATH_TO_LUA_JIT + " -b " + OUTPUT_PATH_MERGED_LUA + " " + OUTPUT_PATH_MERGED_JIT);
}

if (p.luajitify && p.minify) {
  console.log("luajit compile minified merged lua file to " + OUTPUT_PATH_MINIFIED_JIT);
  exec(PATH_TO_LUA_JIT + " -b " + OUTPUT_PATH_MINIFIED_LUA + " " + OUTPUT_PATH_MINIFIED_JIT);
}
