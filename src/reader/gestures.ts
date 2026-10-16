type Contact = Pick<PointerEvent, 'pointerId' | 'pointerType' | 'clientX' | 'clientY' | 'isPrimary'>

/** One gesture can select text or turn a page. Selection keeps ownership until release. */
export class ReaderGestures {
  private down:
    (Contact & { time: number; selected: boolean; distance: number; movedAt?: number }) | null =
    null
  private ignoreClick = false

  start(event: Contact, selected: boolean) {
    if (!event.isPrimary) {
      this.cancel()
      return
    }
    this.down = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
      isPrimary: event.isPrimary,
      time: Date.now(),
      selected,
      distance: 0,
    }
    this.ignoreClick = selected
  }

  select() {
    if (this.down) this.down.selected = true
    this.ignoreClick = true
  }

  move(event: Contact) {
    if (!this.down || this.down.pointerId !== event.pointerId) return
    this.down.distance = Math.max(
      this.down.distance,
      Math.hypot(event.clientX - this.down.clientX, event.clientY - this.down.clientY),
    )
    if (this.down.distance > 8) {
      this.down.movedAt ??= Date.now()
      this.ignoreClick = true
    }
  }

  end(event: Contact, selected: boolean) {
    this.move(event)
    const down = this.down
    if (!down || down.pointerId !== event.pointerId) return { turn: null, dismiss: false }
    this.down = null
    // A slow continuous swipe is not a long press. Only time spent still counts.
    const held = (down.movedAt ?? Date.now()) - down.time >= 500
    const moved = down.distance > 8
    this.ignoreClick ||= down.selected || selected || held || moved
    const dx = event.clientX - down.clientX
    const dy = event.clientY - down.clientY
    const swipe =
      down.pointerType === 'touch' &&
      !down.selected &&
      !selected &&
      !held &&
      Math.abs(dx) > 70 &&
      Math.abs(dx) > Math.abs(dy) * 1.5
    return {
      turn: swipe ? (dx > 0 ? ('previous' as const) : ('next' as const)) : null,
      dismiss: !selected && !held && !moved,
    }
  }

  blocksClick(selected: boolean) {
    return selected || this.ignoreClick || !!this.down
  }

  cancel() {
    this.down = null
    this.ignoreClick = true
  }
}
