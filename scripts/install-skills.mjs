#!/usr/bin/env node
/**
 * Install the bundled Studio companion skills into a game repository.
 *
 * Zero dependencies: copies every bundled skill directory from this repository
 * to `<target>/<dir>/<name>/SKILL.md`, plus the skills index as
 * `<target>/<dir>/README.md`, creating directories as needed. Existing skills
 * are skipped unless `--force` is passed.
 *
 * Usage:
 *   node scripts/install-skills.mjs --target <game-repo> [--dir .agents/skills] [--force]
 *
 * Exit codes: 0 success (including skips), 1 I/O or validation error, 2 usage error.
 */
import fs from 'node:fs';
import path from 'node:path';

const SKILLS = [
    'studio-workspace',
    'studio-brief',
    'studio-spec',
    'studio-spec-pipeline',
    'studio-shared-repo',
    'studio-bug',
    'studio-bugfix',
    'studio-vault',
    'studio-orchestration',
];
const DEFAULT_DIR = '.agents/skills';
const repoRoot = path.resolve(import.meta.dirname, '..');
const skillsRoot = path.join(repoRoot, 'skills');

function usage() {
    return [
        'Install the bundled Studio companion skills into a game repository.',
        '',
        'Usage:',
        '  node scripts/install-skills.mjs [--target <game-repo>] [--dir <path>] [--force]',
        '',
        'Options:',
        '  --target, -t <dir>   game repository root (default: current directory)',
        '  --dir, -d <path>     destination under the target (default: ' + DEFAULT_DIR + ')',
        '  --force, -f          replace skill directories that already exist',
        '  --help, -h           show this help',
        '',
        'Supported destination conventions include .agents/skills, .claude/skills,',
        '.dsh/skills and .opencode/skills. Each run reports installed, updated and',
        'skipped skills; re-running without --force is safe.',
        '',
        'Bundled skills: ' + SKILLS.join(', '),
    ].join('\n');
}

function fail(message, code = 1) {
    console.error('[skills] ERROR ' + message);
    return { exitCode: code };
}

/** Parse `--flag value`, `--flag=value` and `-f` style arguments. */
function parseArgs(argv) {
    const opts = { target: process.cwd(), dir: DEFAULT_DIR, force: false, help: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
        if (arg === '--force' || arg === '-f') { opts.force = true; continue; }
        const eq = arg.indexOf('=');
        const key = eq >= 0 ? arg.slice(0, eq) : arg;
        const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
        const readValue = () => {
            if (inline !== undefined) {
                if (!inline) throw new Error('missing value for ' + key);
                return inline;
            }
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('-')) throw new Error('missing value for ' + key);
            i += 1;
            return next;
        };
        if (key === '--target' || key === '-t') opts.target = readValue();
        else if (key === '--dir' || key === '-d') opts.dir = readValue();
        else throw new Error('unknown argument: ' + arg);
    }
    return opts;
}

/** Validate that a skill directory exists and starts with usable frontmatter. */
function validateSkill(name) {
    const dir = path.join(skillsRoot, name);
    const file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) return { ok: false, error: 'missing ' + file };
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { return { ok: false, error: 'cannot read ' + file + ': ' + String(err.message || err) }; }
    if (!text.startsWith('---')) return { ok: false, error: file + ' must start with YAML frontmatter' };
    const end = text.indexOf('\n---', 3);
    const front = end < 0 ? '' : text.slice(0, end);
    if (!/^name:\s*\S/m.test(front)) return { ok: false, error: file + ' frontmatter has no name' };
    if (!/^description:\s*\S/m.test(front)) return { ok: false, error: file + ' frontmatter has no description' };
    return { ok: true, dir, file };
}

/** Recursive copy without following symlinks (skills contain plain files). */
function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dest = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(src, dest);
        else if (entry.isFile()) fs.copyFileSync(src, dest);
        else throw new Error('unsupported entry in skill directory: ' + src);
    }
}

function countFiles(dir) {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
        else if (entry.isFile()) count += 1;
    }
    return count;
}

function run(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        console.error(usage());
        return fail(String(err.message || err), 2);
    }
    if (opts.help) {
        console.log(usage());
        return { exitCode: 0 };
    }

    const target = path.resolve(process.cwd(), opts.target);
    const destRoot = path.isAbsolute(opts.dir) ? path.resolve(opts.dir) : path.resolve(target, opts.dir);

    if (!fs.existsSync(skillsRoot)) return fail('bundled skills directory not found: ' + skillsRoot + ' (run from a studio-vault checkout)');
    const problems = [];
    for (const name of SKILLS) {
        const checked = validateSkill(name);
        if (!checked.ok) problems.push(checked.error);
    }
    if (problems.length) return fail('invalid bundled skills:\n  - ' + problems.join('\n  - '));

    let targetCreated = false;
    if (!fs.existsSync(target)) {
        try { fs.mkdirSync(target, { recursive: true }); targetCreated = true; }
        catch (err) { return fail('cannot create target ' + target + ': ' + String(err.message || err)); }
    } else if (!fs.statSync(target).isDirectory()) {
        return fail('target is not a directory: ' + target);
    }

    console.log('[skills] from   ' + skillsRoot);
    console.log('[skills] target ' + destRoot + (targetCreated ? ' (created)' : ''));
    console.log('');

    const installed = [];
    const updated = [];
    const skipped = [];
    try {
        fs.mkdirSync(destRoot, { recursive: true });
        for (const name of SKILLS) {
            const checked = validateSkill(name);
            const dest = path.join(destRoot, name);
            const existed = fs.existsSync(dest);
            if (existed && !opts.force) {
                skipped.push(name);
                console.log('[skills] = ' + name + ' (exists, use --force to update)');
                continue;
            }
            if (existed) fs.rmSync(dest, { recursive: true, force: true });
            copyDir(checked.dir, dest);
            const files = countFiles(dest);
            if (existed) {
                updated.push(name);
                console.log('[skills] ~ ' + name + ' (replaced, ' + files + ' file' + (files === 1 ? '' : 's') + ')');
            } else {
                installed.push(name);
                console.log('[skills] + ' + name + ' (' + files + ' file' + (files === 1 ? '' : 's') + ')');
            }
        }
    } catch (err) {
        return fail(String(err.message || err));
    }

    const indexSrc = path.join(skillsRoot, 'README.md');
    const indexDest = path.join(destRoot, 'README.md');
    if (fs.existsSync(indexSrc)) {
        const indexExisted = fs.existsSync(indexDest);
        if (!indexExisted || opts.force) {
            fs.copyFileSync(indexSrc, indexDest);
            console.log('[skills] ' + (indexExisted ? '~' : '+') + ' README.md (index)');
        } else {
            console.log('[skills] = README.md (index exists, use --force to update)');
        }
    }

    console.log('');
    console.log('[skills] installed ' + installed.length + ' / updated ' + updated.length + ' / skipped ' + skipped.length);
    if (skipped.length) {
        console.log('[skills] hint: re-run with --force to overwrite ' + skipped.join(', '));
    }
    console.log('[skills] next: open ' + path.join(destRoot, 'studio-workspace', 'SKILL.md') + ' or restart the agent session so it reloads skills');
    return { exitCode: 0 };
}

try {
    const result = run(process.argv.slice(2));
    process.exit(result.exitCode);
} catch (err) {
    console.error('[skills] ERROR ' + String((err && err.message) || err));
    process.exit(1);
}
