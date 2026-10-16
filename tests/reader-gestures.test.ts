import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReaderGestures } from '../src/reader/gestures'

const pointer = (x: number, pointerId = 1) => ({
  pointerId,
  pointerType: 'touch',
  clientX: x,
  clientY: 100,
  isPrimary: pointerId === 1,
})

describe('reading selection and page gestures', () => {
  afterEach(() => vi.useRealTimers())

  it('retains selection ownership when a handle drag temporarily collapses the native selection', () => {
    const gestures = new ReaderGestures()
    gestures.start(pointer(200), true)
    gestures.move(pointer(80))
    expect(gestures.end(pointer(30), false)).toEqual({ turn: null, dismiss: false })
    expect(gestures.blocksClick(false)).toBe(true)
    // A new deliberate tap can dismiss selection, but must not turn its page.
    gestures.start(pointer(200), true)
    expect(gestures.end(pointer(200), false)).toEqual({ turn: null, dismiss: true })
    expect(gestures.blocksClick(false)).toBe(true)
  })

  it('does not turn pages after a long press, new selection, canceled pointer or pinch', () => {
    vi.useFakeTimers()
    const gestures = new ReaderGestures()
    gestures.start(pointer(200), false)
    vi.advanceTimersByTime(600)
    expect(gestures.end(pointer(20), false).turn).toBeNull()
    gestures.start(pointer(200), false)
    gestures.select()
    expect(gestures.end(pointer(20), false).turn).toBeNull()
    gestures.start(pointer(200), false)
    gestures.cancel()
    expect(gestures.end(pointer(20), false).turn).toBeNull()
    gestures.start(pointer(200), false)
    gestures.start(pointer(180, 2), false)
    expect(gestures.end(pointer(20), false).turn).toBeNull()
  })

  it('turns once for a fresh horizontal swipe and suppresses its trailing click', () => {
    const gestures = new ReaderGestures()
    gestures.start(pointer(200), false)
    expect(gestures.end(pointer(30), false).turn).toBe('next')
    expect(gestures.blocksClick(false)).toBe(true)
    gestures.start(pointer(30), false)
    expect(gestures.end(pointer(200), false).turn).toBe('previous')
    gestures.start(pointer(200), false)
    expect(gestures.end(pointer(200), false).turn).toBeNull()
    expect(gestures.blocksClick(false)).toBe(false)
  })
  it('accepts a continuous slow diagonal swipe while rejecting a held press and vertical scroll', () => {
    vi.useFakeTimers()
    const gestures = new ReaderGestures()
    gestures.start(pointer(300), false)
    vi.advanceTimersByTime(80)
    gestures.move(pointer(270))
    vi.advanceTimersByTime(800)
    expect(gestures.end({ ...pointer(80), clientY: 160 }, false).turn).toBe('next')
    gestures.start(pointer(300), false)
    vi.advanceTimersByTime(700)
    expect(gestures.end(pointer(80), false).turn).toBeNull()
    gestures.start(pointer(300), false)
    gestures.move({ ...pointer(260), clientY: 200 })
    expect(gestures.end({ ...pointer(200), clientY: 400 }, false).turn).toBeNull()
  })
})
