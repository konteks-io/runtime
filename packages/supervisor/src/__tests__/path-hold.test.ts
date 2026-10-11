import { describe, expect, it } from "vitest";
import { splitTrailingPath, StreamedPathHold } from "../session/path-hold.js";

const chunk = (text: string) => ({ sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text" as const, text } } });

describe("a path split across streamed chunks (10-11, D1)", () => {
  it("holds the path a chunk ends inside, and nothing else", () => {
    expect(splitTrailingPath("I'm in `/Users/person/Library/Applica")).toEqual({ ready: "I'm in `", held: "/Users/person/Library/Applica" });
    expect(splitTrailingPath("I'm in /Users/person/Library/Application ")).toEqual({ ready: "I'm in ", held: "/Users/person/Library/Application " });
    expect(splitTrailingPath("in /Users/p/Library/Application Supp")).toEqual({ ready: "in ", held: "/Users/p/Library/Application Supp" });
    expect(splitTrailingPath("in [x](/Users/p/Library/Application Support/konteks-remote/wor")).toEqual({ ready: "in [x](", held: "/Users/p/Library/Application Support/konteks-remote/wor" });
    expect(splitTrailingPath("C:\\Users\\p\\rep")).toEqual({ ready: "", held: "C:\\Users\\p\\rep" });
    // Windows: a drive letter alone, and "Application Support" with backslashes.
    expect(splitTrailingPath("I'm in `C")).toEqual({ ready: "I'm in `", held: "C" });
    expect(splitTrailingPath("x `C:\\T\\Application Support\\konteks")).toEqual({ ready: "x `", held: "C:\\T\\Application Support\\konteks" });
    expect(splitTrailingPath("Done: `/Users/p/a.txt`.")).toEqual({ ready: "Done: `/Users/p/a.txt`.", held: "" });
    expect(splitTrailingPath("renders as <h2>Title</")).toEqual({ ready: "renders as <h2>Title</", held: "" });
    expect(splitTrailingPath("and/or so")).toEqual({ ready: "and/or so", held: "" });
    expect(splitTrailingPath("My/Application Support")).toEqual({ ready: "My/Application Support", held: "" });
  });

  it("sends a held path with the next chunk, or alone when the reply ends on it", () => {
    const hold = new StreamedPathHold();
    expect(hold.take(chunk("Saved to /Users/p/no"))?.update.content.text).toBe("Saved to ");
    expect(hold.take(chunk("tes.md"))).toBeNull();
    expect(hold.take(chunk(" and done."))?.update.content.text).toBe("/Users/p/notes.md and done.");
    expect(hold.flush()).toBeNull();
    hold.take(chunk("Open /tmp/out"));
    expect(hold.flush()?.update.content.text).toBe("/tmp/out");
    expect(hold.flush()).toBeNull();
  });

  it("never holds a runaway token", () => {
    const long = `/${"a".repeat(5_000)}`;
    expect(splitTrailingPath(long)).toEqual({ ready: long, held: "" });
  });
});
