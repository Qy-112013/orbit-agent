import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  content: string;
  source: string;
}

function skillTerms(value: string): Set<string> {
  const terms = new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []);
  for (const run of value.match(/[\u3400-\u9fff]+/g) ?? []) {
    const chars = [...run];
    chars.forEach((char) => terms.add(char));
    for (let index = 0; index + 1 < chars.length; index += 1) terms.add(`${chars[index]}${chars[index + 1]}`);
  }
  return terms;
}

function parseSkill(id: string, source: string, raw: string): SkillDefinition {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { id, name: id, description: '', keywords: [], content: normalized.trim(), source };
  }
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { id, name: id, description: '', keywords: [], content: normalized.trim(), source };
  const frontmatter = normalized.slice(4, end).split('\n');
  const fields = new Map<string, string>();
  for (const line of frontmatter) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return {
    id: fields.get('id') || id,
    name: fields.get('name') || id,
    description: fields.get('description') || '',
    keywords: (fields.get('keywords') || '').split(',').map((item) => item.trim()).filter(Boolean),
    content: normalized.slice(end + 4).trim(),
    source,
  };
}

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): this {
    this.skills.set(skill.id, { ...skill });
    return this;
  }

  get(id: string): SkillDefinition | null {
    return this.skills.get(id) ?? null;
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()].map((skill) => ({ ...skill }));
  }

  select(query: string, limit = 2): SkillDefinition[] {
    const queryTerms = skillTerms(query);
    return this.list()
      .map((skill) => {
        const haystack = skillTerms(`${skill.id} ${skill.name} ${skill.description} ${skill.keywords.join(' ')} ${skill.content}`);
        return { skill, score: [...queryTerms].filter((term) => haystack.has(term)).length };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
      .slice(0, Math.max(1, Math.min(5, limit)))
      .map(({ skill }) => skill);
  }

  async loadDirectory(directory: string): Promise<this> {
    const root = resolve(directory);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return this;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const source = join(root, entry.name);
      const id = entry.name.slice(0, -3);
      this.register(parseSkill(id, source, await readFile(source, 'utf8')));
    }
    return this;
  }
}
