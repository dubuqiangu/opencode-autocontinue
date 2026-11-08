// JSONC parsing for the plugin config files.
//
// The parser strips // and /* *\/ comments plus trailing commas, normalizes
// single-quoted strings to double-quoted ones and then hands the result to
// JSON.parse.

// `export {}` marks this file as an ES module. Without an import/export
// token ahead of the first type annotation, `node --experimental-strip-types
// --check` treats the file as CommonJS and rejects the type syntax.
export {}

// Skip whitespace and comments starting at `from`, returning the index of the
// next meaningful character (or text.length when only trivia remains).
// The trailing-comma lookahead uses this so a comma followed by a comment and
// then a closing brace is still recognized as a trailing comma.
function skipTrivia(text: string, from: number): number {
  let position = from
  while (position < text.length) {
    const char = text[position]
    if (/\s/.test(char)) {
      position++
      continue
    }
    if (char === "/" && text[position + 1] === "/") {
      while (position < text.length && text[position] !== "\n") position++
      continue
    }
    if (char === "/" && text[position + 1] === "*") {
      position += 2
      while (position < text.length && !(text[position] === "*" && text[position + 1] === "/")) position++
      position += 2
      continue
    }
    return position
  }
  return Math.min(position, text.length)
}

// Normalize the escape sequence that starts at `index` (a backslash) inside a
// string delimited by `quoteChar`.
//
// Double-quoted strings keep STRICT JSON semantics: the escape is copied
// byte for byte, so JSON.parse still turns "\n" into a newline and still
// rejects an invalid escape such as "\d" with a SyntaxError.
//
// Single-quoted strings are LITERAL (Python-style raw strings), because a
// Windows path is far more common in a config file than a control character:
//   \'  -> a bare quote (the only quote escape of a single-quoted string)
//   \\  -> a single backslash
//   \X  -> a literal backslash followed by X, so "C:\path" and
//          "C:\Users\<用户名>\name\file.txt" survive unchanged instead of turning
//          "\n" into a newline or "\t" into a tab
// Write a double-quoted string when a real JSON escape is wanted.
function normalizedEscapeSequence(text: string, index: number, quoteChar: string): string {
  const escapeCharacter = text[index + 1]
  if (quoteChar === '"') return text.slice(index, index + 2)
  if (escapeCharacter === "'") return "'"
  if (escapeCharacter === "\\") return "\\\\"
  return "\\\\" + escapeCharacter
}

/** Strip // and /* *\/ comments and trailing commas from JSONC, then JSON.parse.
 *  Single-quoted strings are normalized to double-quoted so JSON.parse accepts them;
 *  their content is literal (see normalizedEscapeSequence), while a double-quoted
 *  string keeps strict JSON escape semantics. */
export function parseJsonc(text: string): unknown {
  // Tolerate a UTF-8 BOM written by some editors / PowerShell.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let result = ""
  let inString = false
  let quoteChar = ""
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (inString) {
      if (char === "\\" && index + 1 < text.length) {
        // 单引号串按字面量处理（\\ 与 \X 原样保留），双引号串按 JSON 规则处理。
        result += normalizedEscapeSequence(text, index, quoteChar)
        index += 2
        continue
      }
      if (char === quoteChar) {
        inString = false
        // 闭合统一写双引号，兼容 JSON.parse。
        result += '"'
        index++
        continue
      }
      // 单引号串内的裸双引号是普通字符，转成双引号串后必须转义，避免提前断串。
      if (quoteChar === "'" && char === '"') {
        result += '\\"'
      } else {
        result += char
      }
      index++
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quoteChar = char
      // 开头统一写双引号，兼容 JSON.parse。
      result += '"'
      index++
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++
    } else if (char === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++
      index += 2
    } else if (char === ",") {
      // Drop a real trailing comma only when the next non-whitespace char
      // closes the object/array. Commas inside strings never reach here
      // (handled by the inString branch above), so "a,}" stays intact.
      // Look past whitespace AND comments: "1, // note\n}" is a trailing comma.
      const lookahead = skipTrivia(text, index + 1)
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        index++
        continue
      }
      result += char
      index++
    } else {
      result += char
      index++
    }
  }
  return JSON.parse(result)
}
