import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SYSTEM_PROMPT } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { PromptConfig } from '../types.ts';

export class PromptError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PromptError';
    }
}

/** `{{include:rules.md}}` —— 把公共片段拼进主提示词。 */
const INCLUDE_PATTERN = /\{\{\s*include\s*:\s*([^}]+?)\s*\}\}/g;
const MAX_INCLUDE_DEPTH = 4;
const GROUPS_DIR = 'groups';

export interface PromptStoreOptions {
    config: PromptConfig;
    /** 相对路径的解析基准（一般是进程工作目录）。 */
    baseDir: string;
    logger: Logger;
}

export interface PromptSource {
    systemFor(groupId: number): string;
    reload?(): void;
}

/**
 * 从 `prompts/` 目录读取系统提示词：
 *   1. `prompt.perGroup[群号]` 显式指定 > 2. `prompts/groups/<群号>.md` > 3. `prompts/system.md`
 * 文件按需读取并缓存；`reload()` 之后修改才会生效。
 */
export class PromptStore implements PromptSource {
    readonly dir: string;
    readonly mainPath: string;

    private readonly baseDir: string;
    private readonly config: PromptConfig;
    private readonly logger: Logger;
    private readonly cache = new Map<string, string>();
    private mainTemplate = '';
    private groupFiles: string[] = [];

    constructor(options: PromptStoreOptions) {
        this.baseDir = options.baseDir;
        this.config = options.config;
        this.logger = options.logger;
        this.dir = path.resolve(options.baseDir, options.config.dir);
        this.mainPath = path.resolve(this.dir, this.config.main);
        this.load();
    }

    /** 当前已存在的群专属提示词文件（相对 prompts 目录）。 */
    get overrides(): readonly string[] {
        return this.groupFiles;
    }

    systemFor(groupId: number): string {
        const explicit = this.config.perGroup[String(groupId)];

        if (explicit) {
            return this.readTemplate(explicit);
        }

        const conventional = `${GROUPS_DIR}/${groupId}.md`;

        if (fs.existsSync(path.join(this.dir, conventional))) {
            return this.readTemplate(conventional);
        }

        if (this.mainTemplate.length === 0) {
            throw new PromptError(`提示词为空：${this.mainPath}`);
        }

        return this.mainTemplate;
    }

    reload(): void {
        this.cache.clear();
        this.load();
    }

    private load(): void {
        fs.mkdirSync(path.join(this.dir, GROUPS_DIR), { recursive: true });

        if (!fs.existsSync(this.mainPath)) {
            this.createDefaultMain();
        }

        this.mainTemplate = this.readTemplate(this.config.main);
        this.groupFiles = this.collectGroupFiles();
        this.logger.info(
            `提示词：${path.relative(this.baseDir, this.mainPath).replace(/\\/g, '/')}`,
            this.groupFiles.length > 0 ? `群专属：${this.groupFiles.join(', ')}` : '群专属：无',
        );
    }

    /** 主提示词缺失时自动生成：优先沿用配置里的旧 system 字段，否则写内置默认值。 */
    private createDefaultMain(): void {
        const content =
            this.config.system && this.config.system.trim().length > 0
                ? `${this.config.system.trim()}\n`
                : `${DEFAULT_SYSTEM_PROMPT}\n`;

        fs.mkdirSync(path.dirname(this.mainPath), { recursive: true });
        fs.writeFileSync(this.mainPath, content, 'utf8');
        this.logger.warn(
            `未找到主提示词，已生成 ${path.relative(this.baseDir, this.mainPath).replace(/\\/g, '/')}`,
            this.config.system ? '内容来自配置里的 prompt.system（已废弃字段）' : '内容为内置默认值，请按需修改',
        );
    }

    private collectGroupFiles(): string[] {
        const directory = path.join(this.dir, GROUPS_DIR);

        if (!fs.existsSync(directory)) {
            return [];
        }

        return fs
            .readdirSync(directory)
            .filter((name) => /^\d+\.md$/.test(name))
            .sort()
            .map((name) => `${GROUPS_DIR}/${name}`);
    }

    private readTemplate(relative: string): string {
        const clean = this.normalizeRelative(relative);
        const cached = this.cache.get(clean);

        if (cached !== undefined) {
            return cached;
        }

        const content = this.readWithIncludes(clean, []);

        if (content.trim().length === 0) {
            throw new PromptError(`提示词文件内容为空：${path.join(this.dir, clean)}`);
        }

        this.cache.set(clean, content);

        return content;
    }

    private readWithIncludes(relative: string, stack: string[]): string {
        if (stack.includes(relative)) {
            throw new PromptError(`提示词 include 出现循环：${[...stack, relative].join(' -> ')}`);
        }

        if (stack.length >= MAX_INCLUDE_DEPTH) {
            throw new PromptError(
                `提示词 include 层级超过 ${MAX_INCLUDE_DEPTH} 层：${[...stack, relative].join(' -> ')}`,
            );
        }

        const absolute = path.join(this.dir, relative);
        let raw: string;

        try {
            raw = fs.readFileSync(absolute, 'utf8');
        } catch (error) {
            throw new PromptError(
                `读取提示词文件失败：${absolute}（${error instanceof Error ? error.message : String(error)}）`,
            );
        }

        const content = normalizeText(raw);

        return content.replace(INCLUDE_PATTERN, (_match, target: string) =>
            this.readWithIncludes(this.normalizeRelative(target), [...stack, relative]).trimEnd(),
        );
    }

    /** 只允许 prompts 目录内的相对路径，挡住 `../` 穿越与绝对路径。 */
    private normalizeRelative(relative: string): string {
        const cleaned = relative.replace(/\\/g, '/').trim();

        if (cleaned.length === 0) {
            throw new PromptError('提示词文件路径不能为空');
        }

        if (path.isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned)) {
            throw new PromptError(`提示词文件必须使用 prompts 目录内的相对路径：${relative}`);
        }

        const resolved = path.resolve(this.dir, cleaned);
        const inside = path.relative(this.dir, resolved);

        if (inside.startsWith('..') || path.isAbsolute(inside)) {
            throw new PromptError(`提示词文件不能指向 prompts 目录之外：${relative}`);
        }

        return inside.replace(/\\/g, '/');
    }
}

function normalizeText(raw: string): string {
    return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}
