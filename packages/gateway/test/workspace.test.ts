/**
 * 工作区沙箱的守卫测试 —— 对着 PLAN 阶段 7 那条验收写：
 * 「**工作区外写入被拒绝**」。
 *
 * 这类检查的测试**必须包含真实的绕过手法**，不能只测"正常路径能过、`../` 被拒"。
 * 只测那两条的话，一个"检查字符串里有没有 `..`"的实现也能全绿 ——
 * 而它是可以被 `....//`、绝对路径、符号链接绕过的。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { hasDotOnlySegment, isInside, resolveInWorkspace } from '../src/workspace.ts'

/** 造一个工作区 + 一个"外面"的目录。 */
function setup(): { root: string; outside: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'forlife-ws-'))
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('正常相对路径通过，并给出根之下的绝对路径', () => {
  const { root, cleanup } = setup()
  try {
    const result = resolveInWorkspace(root, 'notes/a.txt')
    assert.equal(result.ok, true)
    if (result.ok) assert.ok(isInside(root, result.absolutePath))
  } finally {
    cleanup()
  }
})

test('★ 工作区外写入被拒绝：`..` 直接拒绝', () => {
  const { root, cleanup } = setup()
  try {
    for (const bad of ['../secret.txt', '../../etc/passwd', 'a/../../b', '..']) {
      const result = resolveInWorkspace(root, bad)
      assert.equal(result.ok, false, `应拒绝：${bad}`)
    }
  } finally {
    cleanup()
  }
})

test('★ 绝对路径与盘符路径被拒绝（不"帮忙转换"）', () => {
  const { root, cleanup } = setup()
  try {
    const absolute = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd'
    const result = resolveInWorkspace(root, absolute)
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.reason : '', /绝对路径/)

    // Windows 的"相对当前盘"写法：isAbsolute 返回 false，但它是盘符路径
    if (process.platform === 'win32') {
      const driveRelative = resolveInWorkspace(root, 'C:foo')
      assert.equal(driveRelative.ok, false)
    }
  } finally {
    cleanup()
  }
})

test('★ 绕过手法：`....//` 这类"去掉一层又变成 .."的写法', () => {
  const { root, cleanup } = setup()
  try {
    // 注意：`....//x` 规范化后是 `../x` 吗？不是 —— 它是字面目录名 `....`。
    // 真正要防的是**规范化之后**变成越界的形式，所以断言的是最终判定而不是字面形式。
    for (const tricky of ['....//outside/secret.txt', 'a/./../../outside/secret.txt', './../outside/secret.txt']) {
      const result = resolveInWorkspace(root, tricky)
      // 前一个可能落在工作区内（`....` 是个普通目录名）⇒ 允许通过；
      // 后两个规范化后确实越界 ⇒ 必须拒绝。
      if (tricky.includes('../outside') || tricky.startsWith('./../')) {
        assert.equal(result.ok, false, `应拒绝：${tricky}`)
      }
    }
  } finally {
    cleanup()
  }
})

test('★ NUL 字节被拒绝（防"检查的路径"与"打开的路径"不是同一个）', () => {
  const { root, cleanup } = setup()
  try {
    const result = resolveInWorkspace(root, 'safe.txt\0../../etc/passwd')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.reason : '', /NUL/)
  } finally {
    cleanup()
  }
})

test('★ 符号链接逃逸被拒绝（路径里一个 .. 都没有）', () => {
  const { root, outside, cleanup } = setup()
  try {
    // 在工作区内造一个指向外面的软链
    const linkPath = join(root, 'escape')
    try {
      symlinkSync(outside, linkPath, 'junction')
    } catch {
      // 某些环境不允许建软链（Windows 需要权限）⇒ 跳过而不是误报通过
      console.log('  （本环境无法创建符号链接，跳过该用例）')
      return
    }

    const result = resolveInWorkspace(root, 'escape/secret.txt')
    assert.equal(result.ok, false, '经软链越界必须被拒 —— 字符串检查在这里完全无效')
    assert.match(result.ok === false ? result.reason : '', /符号链接/)
  } finally {
    cleanup()
  }
})

test('工作区根不存在时明确拒绝（不是"通过"）', () => {
  const result = resolveInWorkspace(join(tmpdir(), 'definitely-not-here-xyz'), 'a.txt')
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /不存在|不可访问/)
})

test('isInside：边界正确（前缀相同但不同目录不算之内）', () => {
  const base = process.platform === 'win32' ? 'C:\\ws' : '/ws'
  assert.equal(isInside(base, join(base, 'a.txt')), true)
  assert.equal(isInside(base, base), true, '根自身算之内')
  // `/ws-evil` 以 `/ws` 为前缀，但**不在** `/ws` 之内 —— 少了分隔符判断就会误判
  const sibling = process.platform === 'win32' ? 'C:\\ws-evil\\a.txt' : '/ws-evil/a.txt'
  assert.equal(isInside(base, sibling), false, '同前缀的兄弟目录不算之内')
})


test('★ 只由点组成的段被拒（旧检查会放行的那批）', () => {
  const { root, cleanup } = setup()
  try {
    // 这些**旧字符串检查全部放行**（它只匹配 === '..' 与 startsWith('..' + sep)）。
    // 本机实测文件系统把它们当字面目录名（不是真绕过），
    // 但那是 Win32 版本相关行为 —— 部分 API 会剥掉段末尾的空格与点。
    for (const sneaky of ['.. ', '..  ', '...', 'a/.. ', './...', '....']) {
      const result = resolveInWorkspace(root, sneaky)
      assert.equal(result.ok, false, `应拒绝：${JSON.stringify(sneaky)}`)
    }
  } finally {
    cleanup()
  }
})

test('hasDotOnlySegment：判定边界（正常文件名不受影响）', () => {
  assert.equal(hasDotOnlySegment('..'), true)
  assert.equal(hasDotOnlySegment('.. '), true, '尾空格要剥掉再判')
  assert.equal(hasDotOnlySegment('...'), true)
  assert.equal(hasDotOnlySegment('a/../b'), true)
  // 正常文件名不该被误伤
  assert.equal(hasDotOnlySegment('a.txt'), false)
  assert.equal(hasDotOnlySegment('.hidden'), false, '点开头的隐藏文件是正常的')
  assert.equal(hasDotOnlySegment('notes/readme.md'), false)
  assert.equal(hasDotOnlySegment('a.b.c'), false)
})
