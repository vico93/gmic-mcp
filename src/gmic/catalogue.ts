export interface CommandDoc {
  name: string;
  category: string;
  arguments: string;
  description: string;
  documentation: string;
}

/** Parse documentation data, without evaluating any G'MIC expressions or examples. */
export function parseCatalogue(source: string): CommandDoc[] {
  const commands = new Map<string, CommandDoc>();
  let category = 'Uncategorized';
  let current: CommandDoc | undefined;
  let continuation: 'arguments' | 'documentation' | undefined;
  const finish = () => {
    if (!current) return;
    current.documentation = current.documentation.trim();
    current.description =
      current.documentation
        .split(/\n\s*\n/)[0]
        ?.replace(/\s+/g, ' ')
        .trim() || current.arguments;
    commands.set(current.name, current);
    current = undefined;
  };
  for (const line of source.split(/\r?\n/)) {
    const section = /^\s*#@cli\s*::\s*(.*)$/.exec(line);
    if (section) {
      finish();
      category = section[1]!.trim();
      continuation = undefined;
      continue;
    }
    const header = /^\s*#@cli\s+([^\s:]+)\s*:\s*(.*)$/.exec(line);
    if (header) {
      finish();
      current = {
        name: header[1]!,
        category,
        arguments: header[2]!.replace(/\\\s*$/, ''),
        description: '',
        documentation: '',
      };
      continuation = /\\\s*$/.test(line) ? 'arguments' : undefined;
      continue;
    }
    const body = /^\s*#@cli\s*:\s?(.*)$/.exec(line);
    if (body && current) {
      current.documentation += `${body[1]!.replace(/\\\s*$/, '')}\n`;
      continuation = /\\\s*$/.test(line) ? 'documentation' : undefined;
    } else if (continuation && current && /^\s*#(?!@)/.test(line)) {
      const text = line.replace(/^\s*#\s?/, '').replace(/\\\s*$/, '');
      if (continuation === 'arguments') current.arguments += ` ${text}`;
      else current.documentation = current.documentation.trimEnd() + ` ${text}\n`;
      continuation = /\\\s*$/.test(line) ? continuation : undefined;
    } else continuation = undefined;
  }
  finish();
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function searchCatalogue(
  commands: CommandDoc[],
  query: string,
  category?: string,
): CommandDoc[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return commands
    .filter((command) => {
      if (category && !command.category.toLowerCase().includes(category.toLowerCase()))
        return false;
      const haystack = `${command.name} ${command.description} ${command.arguments}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => {
      const score = (command: CommandDoc) =>
        words.reduce(
          (total, word) =>
            total +
            (command.name.toLowerCase() === word
              ? 4
              : command.name.toLowerCase().includes(word)
                ? 2
                : 0),
          0,
        );
      return score(b) - score(a) || a.name.localeCompare(b.name, 'en');
    });
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
