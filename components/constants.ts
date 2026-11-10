export type Lang = 'c' | 'python' | 'rust';

export type LangConfig = {
  label: string;
  /** The entry file: where runs start. It can't be renamed or deleted. */
  fsKey: string;
  /** DAP `setBreakpoints` path — must match the worker's virtual source path. */
  sourcePath: string;
  defaultCode: string;
  /** Whether this language supports breakpoints / the DAP debugger. */
  debug: boolean;
};

export const LANGS: Record<Lang, LangConfig> = {
  c: {
    label: 'C++',
    fsKey: 'main.cpp',
    sourcePath: '/main.cpp',
    defaultCode: `#include <iostream>
#include "vector.h"
#include "SimpleTest.h"

using namespace std;

PROVIDED_TEST("Vector basic ops") {
  Vector<int> v;
  v.add(1);
  v.add(2);
  EXPECT_EQUAL(v.size(), 2);
  EXPECT_EQUAL(v[0], 1);
}

int main() {
  Vector<string> words;
  words.add("hello");
  words.add("world");
  cout << "main: " << words << endl;
  return 0;
}
`,
    debug: true,
  },
  python: {
    label: 'Python',
    fsKey: 'main.py',
    sourcePath: '/main.py',
    defaultCode: `print("Hello, world!")
`,
    debug: true,
  },
  rust: {
    label: 'Rust',
    fsKey: 'main.rs',
    sourcePath: '/main.rs',
    defaultCode: `fn main() {
    println!("Hello, world!");
}
`,
    debug: true,
  },
};

/** @deprecated Use LANGS[lang].sourcePath instead. */
export const SOURCE_PATH = LANGS.c.sourcePath;

/** @deprecated Use LANGS.c.defaultCode instead. */
export const defaultCode = LANGS.c.defaultCode;
