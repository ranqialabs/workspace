import { expect, test } from "bun:test"

import { migrate } from "../src/store/migrations"
import { memoryDatabase } from "./memory-database"

const tables = (db: ReturnType<typeof memoryDatabase>) =>
  db.sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((row) => row.name)

test("a fresh database runs every step", () => {
  const db = memoryDatabase()
  migrate(db, "config", ["CREATE TABLE a (x)", "CREATE TABLE b (y)"])
  expect(tables(db)).toEqual(["_migrations", "a", "b"])
})

test("a later boot runs only the steps it has not seen", () => {
  const db = memoryDatabase()
  migrate(db, "config", ["CREATE TABLE a (x)"])
  migrate(db, "config", ["CREATE TABLE a (x)", "CREATE TABLE b (y)"])
  expect(tables(db)).toEqual(["_migrations", "a", "b"])
})

test("names keep separate counts", () => {
  const db = memoryDatabase()
  migrate(db, "one", ["CREATE TABLE a (x)"])
  migrate(db, "two", ["CREATE TABLE b (y)"])
  expect(tables(db)).toEqual(["_migrations", "a", "b"])
})

test("a failing step rolls the whole batch back", () => {
  const db = memoryDatabase()
  expect(() => migrate(db, "config", ["CREATE TABLE a (x)", "NOT SQL"])).toThrow()
  expect(tables(db)).toEqual(["_migrations"])
})
