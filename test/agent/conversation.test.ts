import { expect, test } from "bun:test"

import { conversationName, parsePress } from "../../src/agent/conversation"

test("a button id names its action, target and conversation", () => {
  const name = conversationName("slack", "C1", "1700.01")
  expect(parsePress(`bob:submit:12:${name}`)).toEqual({
    action: "submit",
    target: 12,
    conversation: "slack:C1:1700.01",
  })
})

test("anything else is not a press", () => {
  expect(parsePress("bob:delete:1:discord:c:")).toBeUndefined()
  expect(parsePress("bob:stop:x:discord:c:")).toBeUndefined()
  expect(parsePress("bob:stop:0:")).toBeUndefined()
  expect(parsePress("other:stop:0:discord:c:")).toBeUndefined()
})
