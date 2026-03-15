function splitOutsideQuotes(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" || character === "\"") {
      if (quote === character) {
        if (character === "'" && value[index + 1] === "'") {
          current += "''";
          index += 1;
          continue;
        }
        quote = null;
      } else if (quote === null) {
        quote = character;
      }
      current += character;
      continue;
    }
    if (character === delimiter && quote === null) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, "");
}

function quoteNewickLabelIfNeeded(value: string): string {
  const trimmed = stripWrappingQuotes(value);
  if (!trimmed) {
    return "";
  }
  return /[\s(),:;[\]'"]/.test(trimmed)
    ? `'${trimmed.replaceAll("'", "''")}'`
    : trimmed;
}

function skipBracketComment(text: string, startIndex: number): number {
  let depth = 1;
  let index = startIndex + 1;
  while (index < text.length && depth > 0) {
    if (text[index] === "[") {
      depth += 1;
    } else if (text[index] === "]") {
      depth -= 1;
    }
    index += 1;
  }
  return index;
}

function skipQuotedToken(text: string, startIndex: number, quote: "'" | "\""): number {
  let index = startIndex + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        index += 2;
        continue;
      }
      if (quote === "\"" && text[index - 1] === "\\") {
        index += 1;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return index;
}

function readNexusStatementBody(block: string, startIndex: number): { body: string; endIndex: number } | null {
  let quote: "'" | "\"" | null = null;
  let depth = 0;
  let index = startIndex;
  while (index < block.length) {
    const character = block[index];
    if (quote !== null) {
      index = skipQuotedToken(block, index - 1, quote);
      quote = null;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "[") {
      index = skipBracketComment(block, index);
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")" && depth > 0) {
      depth -= 1;
    } else if (character === ";" && depth === 0) {
      return {
        body: block.slice(startIndex, index + 1).trim(),
        endIndex: index + 1,
      };
    }
    index += 1;
  }
  return null;
}

function extractNexusStatement(block: string, keywords: string[]): string | null {
  let index = 0;
  while (index < block.length) {
    const character = block[index];
    if (character === "'" || character === "\"") {
      index = skipQuotedToken(block, index, character);
      continue;
    }
    if (character === "[") {
      index = skipBracketComment(block, index);
      continue;
    }
    if (!/[A-Za-z]/.test(character)) {
      index += 1;
      continue;
    }
    const wordStart = index;
    while (index < block.length && /[A-Za-z]/.test(block[index])) {
      index += 1;
    }
    const keyword = block.slice(wordStart, index).toLowerCase();
    if (!keywords.includes(keyword)) {
      continue;
    }
    while (index < block.length && /\s/.test(block[index])) {
      index += 1;
    }
    const statement = readNexusStatementBody(block, index);
    if (statement) {
      return statement.body;
    }
    return null;
  }
  return null;
}

interface NexusTreeStatement {
  body: string;
  isDefault: boolean;
}

function extractNexusTreeBlocks(text: string): string[] {
  const blocks = Array.from(text.matchAll(/begin\s+trees\s*;([\s\S]*?)end\s*;/ig), (match) => match[1]);
  return blocks.length > 0 ? blocks : [text];
}

function extractNexusTreeStatements(block: string): NexusTreeStatement[] {
  const statements: NexusTreeStatement[] = [];
  let index = 0;
  while (index < block.length) {
    const character = block[index];
    if (character === "'" || character === "\"") {
      index = skipQuotedToken(block, index, character);
      continue;
    }
    if (character === "[") {
      index = skipBracketComment(block, index);
      continue;
    }
    if (!/[A-Za-z]/.test(character)) {
      index += 1;
      continue;
    }
    const wordStart = index;
    while (index < block.length && /[A-Za-z]/.test(block[index])) {
      index += 1;
    }
    const keyword = block.slice(wordStart, index).toLowerCase();
    if (keyword !== "tree" && keyword !== "utree") {
      continue;
    }
    while (index < block.length && /\s/.test(block[index])) {
      index += 1;
    }
    let isDefault = false;
    if (block[index] === "*") {
      isDefault = true;
      index += 1;
      while (index < block.length && /\s/.test(block[index])) {
        index += 1;
      }
    }
    const statement = readNexusStatementBody(block, index);
    if (!statement) {
      break;
    }
    statements.push({
      body: statement.body,
      isDefault,
    });
    index = statement.endIndex;
  }
  return statements;
}

function parseTranslateMap(block: string): Map<string, string> {
  const translate = new Map<string, string>();
  const statement = extractNexusStatement(block, ["translate"]);
  if (!statement) {
    return translate;
  }
  const normalizedStatement = statement.endsWith(";") ? statement.slice(0, -1) : statement;
  const entries = splitOutsideQuotes(normalizedStatement, ",");
  for (let index = 0; index < entries.length; index += 1) {
    const match = /^(\S+)\s+(.+)$/.exec(entries[index].trim());
    if (!match) {
      continue;
    }
    translate.set(match[1], stripWrappingQuotes(match[2]));
  }
  return translate;
}

function extractFirstTreeStatement(block: string): string | null {
  const statement = extractNexusStatement(block, ["tree", "utree"]);
  if (!statement) {
    return null;
  }
  const equalsIndex = statement.indexOf("=");
  if (equalsIndex < 0) {
    return null;
  }
  return statement.slice(equalsIndex + 1).trim();
}

function extractTreeNewick(statement: string): string | null {
  const equalsIndex = statement.indexOf("=");
  if (equalsIndex < 0) {
    return null;
  }
  return statement.slice(equalsIndex + 1).trim();
}

function applyNexusTranslate(newick: string, translate: Map<string, string>): string {
  if (translate.size === 0) {
    return newick;
  }
  let output = "";
  let token = "";
  let quote: "'" | "\"" | null = null;
  const flushToken = (): void => {
    if (!token) {
      return;
    }
    const translated = translate.get(token);
    output += translated ? quoteNewickLabelIfNeeded(translated) : token;
    token = "";
  };
  for (let index = 0; index < newick.length; index += 1) {
    const character = newick[index];
    if (character === "'" || character === "\"") {
      flushToken();
      if (quote === character) {
        if (character === "'" && newick[index + 1] === "'") {
          output += "''";
          index += 1;
          continue;
        }
        quote = null;
      } else if (quote === null) {
        quote = character;
      }
      output += character;
      continue;
    }
    if (quote !== null) {
      output += character;
      continue;
    }
    if (character === "[") {
      flushToken();
      const commentEnd = skipBracketComment(newick, index);
      output += newick.slice(index, commentEnd);
      index = commentEnd - 1;
      continue;
    }
    if (/[\s(),:=;[\]]/.test(character)) {
      flushToken();
      output += character;
      continue;
    }
    token += character;
  }
  flushToken();
  return output;
}

export function normalizeImportedTreeText(text: string): string {
  const trimmed = text.trim();
  if (!/^#?nexus/i.test(trimmed) && !/begin\s+trees\s*;/i.test(trimmed)) {
    return text;
  }
  const blocks = extractNexusTreeBlocks(trimmed);
  let firstTree: string | null = null;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const translate = parseTranslateMap(block);
    const treeStatements = extractNexusTreeStatements(block);
    for (let treeIndex = 0; treeIndex < treeStatements.length; treeIndex += 1) {
      const treeStatement = treeStatements[treeIndex];
      const newick = extractTreeNewick(treeStatement.body);
      if (!newick) {
        continue;
      }
      const normalized = applyNexusTranslate(newick, translate);
      if (treeStatement.isDefault) {
        return normalized;
      }
      if (firstTree === null) {
        firstTree = normalized;
      }
    }
    if (treeStatements.length === 0) {
      const legacyTree = extractFirstTreeStatement(block);
      if (legacyTree && firstTree === null) {
        firstTree = applyNexusTranslate(legacyTree, translate);
      }
    }
  }
  return firstTree ?? text;
}
