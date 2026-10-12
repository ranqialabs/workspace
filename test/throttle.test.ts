import { expect, test } from "bun:test"

import { Throttled } from "../src/chat/throttle"

test("updates inside one interval go out as the latest only", async () => {
  const sent: number[] = []
  const live = new Throttled<number>(async (value) => void sent.push(value), 20)
  live.update(1)
  live.update(2)
  live.update(3)
  await Bun.sleep(40)
  expect(sent).toEqual([3])
})

test("settle drops what has not gone out and waits for what has", async () => {
  const sent: number[] = []
  const live = new Throttled<number>(async (value) => {
    await Bun.sleep(10)
    sent.push(value)
  }, 0)
  live.update(1)
  await Bun.sleep(1)
  live.update(2)
  await live.settle()
  expect(sent).toEqual([1])
  await Bun.sleep(20)
  expect(sent).toEqual([1])
})

test("a failed edit does not stop the next one", async () => {
  const sent: number[] = []
  const live = new Throttled<number>(async (value) => {
    if (value === 1) throw new Error("rate limited")
    sent.push(value)
  }, 0)
  live.update(1)
  await Bun.sleep(5)
  live.update(2)
  await Bun.sleep(5)
  expect(sent).toEqual([2])
})
