import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const args = process.argv.slice(2);

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8'));
}

function getArgValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sanitizeFilePart(value) {
  return String(value)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function readProjectTarget() {
  const projectName = getArgValue('--project') ?? process.env.TAVERN_HELPER_PROJECT;
  if (!projectName) {
    return undefined;
  }
  const projectsFile = readJson('projects.json');
  const project = projectsFile.projects?.[projectName];
  if (!project) {
    throw new Error(`Unknown project '${projectName}'.`);
  }
  return { name: projectName, ...project };
}

function getVersion(config, projectTarget) {
  const packageJson = readJson('package.json');
  return requireString(config.version ?? projectTarget?.version ?? packageJson.version, 'project version');
}

function getExpectedTag(version) {
  return `v${version}`;
}

function getCurrentTag() {
  return (
    getArgValue('--tag') ??
    process.env.RELEASE_TAG ??
    (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined)
  );
}

function checkTag(version) {
  const expectedTag = getExpectedTag(version);
  const actualTag = getCurrentTag();
  if (!actualTag) {
    throw new Error(`Release tag is required and must be ${expectedTag}.`);
  }
  if (actualTag !== expectedTag) {
    throw new Error(`Release tag ${actualTag} does not match package.json version ${version}; expected ${expectedTag}.`);
  }
  console.info(`Release tag ${actualTag} matches package.json version ${version}.`);
}

function stripSourceMapComment(content) {
  return content.replace(/\r?\n?\/\/# sourceMappingURL=.*(?:\r?\n)?$/u, '');
}

function buildScriptJson(config, content, version) {
  const script = config.script ?? {};
  const baseName = requireString(script.baseName ?? script.name, 'script.baseName');
  return {
    type: script.type ?? 'script',
    enabled: script.enabled !== false,
    name: `${baseName}v${version}`,
    id: requireString(script.id, 'script.id'),
    content,
    info: typeof script.info === 'string' ? script.info : '',
    button: script.button ?? { enabled: false, buttons: [] },
    data: script.data ?? {},
  };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.info(`Wrote ${path.relative(cwd, file)}`);
}

function packageScript() {
  const projectTarget = readProjectTarget();
  const configPath = getArgValue('--config') ?? projectTarget?.scriptConfig ?? 'tavern-helper-script.config.json';
  const config = readJson(configPath);
  if (config.enabled === false) {
    console.info(`${configPath} is disabled; no script JSON package was generated.`);
    return;
  }

  const version = getVersion(config, projectTarget);
  if (process.env.GITHUB_REF_TYPE === 'tag' || process.env.RELEASE_TAG || args.includes('--tag')) {
    checkTag(version);
  }

  const distPath = path.resolve(cwd, requireString(config.dist, 'dist'));
  const outputDirectory = path.resolve(cwd, config.outputDirectory ?? 'release');
  const fileBaseName = sanitizeFilePart(
    config.fileBaseName ?? projectTarget?.packageName ?? readJson('package.json').name ?? 'tavern-helper-script',
  );
  const remoteUrl = requireString(config.remoteUrl, 'remoteUrl');

  if (!fs.existsSync(distPath)) {
    throw new Error(`Built script file does not exist: ${path.relative(cwd, distPath)}`);
  }

  const remoteContent = `import '${remoteUrl}'`;
  const inlineContent = stripSourceMapComment(fs.readFileSync(distPath, 'utf8'));
  const remoteJson = buildScriptJson(config, remoteContent, version);
  const inlineJson = buildScriptJson(config, inlineContent, version);
  const versionedBaseName = `${fileBaseName}-v${version}`;

  writeJson(path.join(outputDirectory, `${versionedBaseName}.json`), remoteJson);
  writeJson(path.join(outputDirectory, `${versionedBaseName}.inline.json`), inlineJson);
}

try {
  const projectTarget = readProjectTarget();
  const configPath = getArgValue('--config') ?? projectTarget?.scriptConfig ?? 'tavern-helper-script.config.json';
  const config = readJson(configPath);
  if (args.includes('--check-tag')) {
    checkTag(getVersion(config, projectTarget));
  } else {
    packageScript();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
