// A disposable story repo in tmpdir: minimal canon/, a committed prose
// scene, git identity configured. Each test file makes its own and points
// ARC_STORY_PATH at it BEFORE importing any src module — config resolves
// paths at module load.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

export function writeScene(dir: string, rel: string, id: string, body: string, extraFrontmatter = ''): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(
    path.join(dir, rel),
    `---\nscene: ${id}\nchapter: ch.01\nstatus: proposed\nfacts: []\nevents: []\n${extraFrontmatter}---\n\n${body}\n`,
  )
}

export function makeStory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-story-'))
  fs.mkdirSync(path.join(dir, 'canon'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'canon', 'story.yaml'), 'title: Test Story\n')
  writeScene(dir, 'prose/ch-01/scene-01.md', 'sc.01-1', 'Original first paragraph.\n\nSecond paragraph.')
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@test')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'prose: first scene')
  return dir
}
