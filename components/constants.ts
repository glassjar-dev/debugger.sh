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
    // String.raw keeps the escapes (\x1b, \n) as Python source instead of turning them into characters.
    defaultCode: String.raw`"""
Welcome to glassjar!

This Python runs on YOUR computer. The interpreter is compiled to
WebAssembly and lives inside this browser tab, so no server is involved.

Press Run to light up the jar. Then click line 45 to set a breakpoint,
press Debug, and step through one firefly at a time.
"""

import math
import random
import sys
import time
from dataclasses import dataclass

WIDTH, HEIGHT = 20, 5  # the inside of the jar, in characters
FRAMES = 110

GLASS = "\x1b[38;5;67m"
LID = "\x1b[38;5;180m"
RESET = "\x1b[0m"
# From a faint ember to full glow.
GLOW = [
    "\x1b[38;5;58m·",
    "\x1b[38;5;94m•",
    "\x1b[38;5;136m•",
    "\x1b[38;5;178m✦",
    "\x1b[38;5;228m✦",
]


@dataclass
class Firefly:
    x: float
    y: float
    dx: float
    dy: float
    phase: float  # where it is in its blink

    def move(self) -> None:
        # Drift a little, then bounce off the glass.
        self.dx = clamp(self.dx + random.uniform(-0.1, 0.1), -0.6, 0.6)
        self.dy = clamp(self.dy + random.uniform(-0.06, 0.06), -0.3, 0.3)
        self.x += self.dx
        self.y += self.dy
        if not 0 <= self.x < WIDTH:
            self.dx = -self.dx
            self.x = clamp(self.x, 0, WIDTH - 1)
        if not 0 <= self.y < HEIGHT:
            self.dy = -self.dy
            self.y = clamp(self.y, 0, HEIGHT - 1)
        self.phase += 0.3

    def brightness(self) -> int:
        """0 (dim) to 4 (bright), pulsing with its blink."""
        return round((math.sin(self.phase) + 1) * 2)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def pause(seconds: float) -> None:
    # WebAssembly can't sleep yet, so we wait by watching the clock.
    end = time.perf_counter() + seconds
    while time.perf_counter() < end:
        pass


def write(text: str) -> None:
    sys.stdout.write(text)
    sys.stdout.flush()


def draw_lid() -> None:
    inner = WIDTH - 4
    label = " glassjar ".center(inner, "▒")
    write(f"{LID}    ╭{'─' * inner}╮\n    │{label}│\n    ╰┬{'─' * (inner - 2)}┬╯\n")
    write(f"{GLASS}  ╭──╯{' ' * (inner - 2)}╰──╮{RESET}\n")


def draw_body(fireflies: list[Firefly], frame: int) -> None:
    cells = [[" "] * WIDTH for _ in range(HEIGHT)]
    for fly in sorted(fireflies, key=Firefly.brightness):
        cells[int(fly.y)][int(fly.x)] = GLOW[fly.brightness()]
    for row in cells:
        write(f"  {GLASS}│{''.join(row)}{GLASS}│{RESET}\n")
    write(f"  {GLASS}╰{'─' * WIDTH}╯{RESET}\n")
    lit = sum(fly.brightness() >= 3 for fly in fireflies)
    write(f"\x1b[2K  {GLASS}{lit} lit · frame {frame + 1} · 0 servers{RESET}\n")


def typewrite(line: str) -> None:
    for i, word in enumerate(line.split(" ")):
        write(word if i == 0 else " " + word)
        pause(0.04)
    write("\n")


def main() -> None:
    fireflies = [
        Firefly(
            x=random.uniform(0, WIDTH - 1),
            y=random.uniform(0, HEIGHT - 1),
            dx=random.uniform(-0.4, 0.4),
            dy=random.uniform(-0.2, 0.2),
            phase=random.uniform(0, math.tau),
        )
        for _ in range(7)
    ]

    write("\x1b[?25l")  # hide the cursor while we animate
    try:
        draw_lid()
        for frame in range(FRAMES):
            if frame > 0:
                write(f"\x1b[{HEIGHT + 2}A")  # back up to redraw the jar in place
            for fly in fireflies:
                fly.move()
            draw_body(fireflies, frame)
            pause(0.04)
    finally:
        write("\x1b[?25h")

    print()
    typewrite("\x1b[1;38;5;228m✦ That ran on your computer:\x1b[0m")
    typewrite("  Python, compiled to")
    typewrite("  WebAssembly, in this tab.")
    print()
    typewrite("\x1b[1;38;5;228m✦ Want to look inside?\x1b[0m")
    typewrite("  Click line 45 for a")
    typewrite("  breakpoint, then press Debug")
    typewrite("  and step through each move.")


main()
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
