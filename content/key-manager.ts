declare const Zotero: any
declare const window: any

import ETA = require('node-eta')
import { kuroshiro } from './key-manager/kuroshiro'

import * as log from './debug'
import { timeout } from './timeout'
import { flash } from './flash'
import { Events } from './events'
import { arXiv } from './arXiv'
import { extract as varExtract } from './var-extract'

import * as ZoteroDB from './db/zotero'

import { getItemsAsync } from './get-items-async'

import { Preferences as Prefs } from './prefs'
import * as Citekey from './key-manager/get-set'
import { Formatter } from './key-manager/formatter'
import { DB } from './db/main'
import { AutoExport } from './auto-export'
import { DB as Cache } from './db/cache'

// export singleton: https://k94n.com/es6-modules-single-instance-pattern
export let KeyManager = new class { // tslint:disable-line:variable-name
  public keys: any
  public query: {
    field: { extra?: number }
    type: {
      note?: number,
      attachment?: number
    }
  }

  private itemObserverDelay: number = Prefs.get('itemObserverDelay')
  private scanning: any[]

  public async pin(ids, inspireHEP = false) {
    ids = this.expandSelection(ids)
    log.debug('KeyManager.pin', ids)

    const inspireSearch = 'http://inspirehep.net/search?of=recjson&ot=system_control_number&p='

    for (const item of await getItemsAsync(ids)) {
      if (item.isNote() || item.isAttachment()) continue

      try {
        let parsed
        let citekey

        if (inspireHEP) {
          parsed = varExtract({ extra: item.getField('extra') })

          let key = parsed.extraFields.csl.DOI || item.getField('DOI') || arXiv.parse(parsed.extraFields.kv.arxiv).id
          if (!key && ['arxiv.org', 'arxiv'].includes((item.getField('libraryCatalog') || '').toLowerCase())) key = arXiv.parse(item.getField('publicationTitle')).id
          if (!key) throw new Error(`No DOI or arXiv ID for ${item.getField('title')}`)

          const results = JSON.parse((await Zotero.HTTP.request('GET', inspireSearch + encodeURIComponent(key))).responseText)
          if (results.length !== 1) throw new Error(`Expected 1 inspire result for ${item.getField('title')}, got ${results.length}`)

          citekey = results[0].system_control_number.find(i => i.institute.endsWith('TeX') && i.value).value

          if (parsed.extraFields.citekey.citekey === citekey && parsed.extraFields.citekey.pinned) continue

        } else {
          parsed = Citekey.get(item.getField('extra'))
          if (parsed.pinned) continue

          citekey = this.get(item.id).citekey || this.update(item)
        }

        item.setField('extra', Citekey.set(parsed.extra, citekey))
        await item.saveTx() // this should cause an update and key registration
      } catch (err) {
        log.error('KeyManager.pin', err)
      }
    }
  }

  public async unpin(ids) {
    ids = this.expandSelection(ids)
    log.debug('KeyManager.unpin', ids)

    for (const item of await getItemsAsync(ids)) {
      if (item.isNote() || item.isAttachment()) continue

      const parsed = Citekey.get(item.getField('extra'))
      if (!parsed.pinned) continue

      log.debug('KeyManager.unpin', item.id)
      item.setField('extra', parsed.extra) // citekey is stripped here but will be regenerated by the notifier
      item.saveTx()
    }

  }

  public async refresh(ids, manual = false) {
    ids = this.expandSelection(ids)
    log.debug('KeyManager.refresh', ids)

    Cache.remove(ids, `refreshing keys for ${ids}`)

    const warnAt = manual ? Prefs.get('warnBulkModify') : 0
    if (warnAt > 0 && ids.length > warnAt) {
      const affected = this.keys.find({ itemID: { $in: ids }, pinned: false }).length
      if (affected > warnAt) {
        const params = { treshold: warnAt, response: null }
        window.openDialog('chrome://zotero-better-bibtex/content/bulk-keys-confirm.xul', '', 'chrome,dialog,centerscreen,modal', params)
        switch (params.response) {
          case 'ok':
            break
          case 'whatever':
            Prefs.set('warnBulkModify', 0)
            break
          default:
            return
        }
      }
    }

    const updates = []
    for (const item of await getItemsAsync(ids)) {
      if (item.isNote() || item.isAttachment()) continue

      const parsed = Citekey.get(item.getField('extra'))
      log.debug('KeyManager.refresh?', item.id, parsed)
      if (parsed.pinned) continue

      this.update(item)
      if (manual) updates.push(item)
    }

    if (manual) AutoExport.changed(updates)
  }

  public async init() {
    log.debug('KeyManager.init...')

    log.debug('initializing kuroshiro')
    await kuroshiro.init()
    log.debug('kuroshiro initialized')

    this.keys = DB.getCollection('citekey')
    log.debug('KeyManager.init:', { keys: this.keys.data.length })

    this.query = {
      field: {},
      type: {},
    }

    for (const field of await ZoteroDB.queryAsync("select fieldID, fieldName from fields where fieldName in ('extra')")) {
      this.query.field[field.fieldName] = field.fieldID
    }
    for (const type of await ZoteroDB.queryAsync("select itemTypeID, typeName from itemTypes where typeName in ('note', 'attachment')")) { // 1, 14
      this.query.type[type.typeName] = type.itemTypeID
    }

    Formatter.init(new Set((await Zotero.DB.queryAsync('select typeName from itemTypes')).map(type => type.typeName.toLowerCase())))
    Formatter.update('init')

    await this.rescan()

    log.debug('KeyManager.init: done')

    Events.on('preference-changed', pref => {
      log.debug('KeyManager.pref changed', pref)
      if (['autoAbbrevStyle', 'citekeyFormat', 'citekeyFold', 'skipWords'].includes(pref)) {
        Formatter.update('pref-change')
      }
    })

    this.keys.on(['insert', 'update'], async citekey => {
      // async is just a heap of fun. Who doesn't enjoy a good race condition?
      // https://github.com/retorquere/zotero-better-bibtex/issues/774
      // https://groups.google.com/forum/#!topic/zotero-dev/yGP4uJQCrMc
      await timeout(this.itemObserverDelay)

      if (Prefs.get('autoPin') && !citekey.pinned) {
        log.debug('Keymanager: auto-pinning', citekey.itemID)
        this.pin([citekey.itemID])
      } else {
        // update display panes by issuing a fake item-update notification
        Zotero.Notifier.trigger('modify', 'item', [citekey.itemID], { [citekey.itemID]: { bbtCitekeyUpdate: true } })
      }
    })
  }

  public async rescan(clean?: boolean) {
    if (Prefs.get('scrubDatabase')) {
      for (const item of this.keys.where(i => i.hasOwnProperty('extra'))) { // 799
        delete item.extra
        this.keys.update(item)
      }
    }

    if (Array.isArray(this.scanning)) {
      let left
      if (this.scanning.length) {
        left = `, ${this.scanning.length} items left`
      } else {
        left = ''
      }
      flash('Scanning still in progress', `Scan is still running${left}`)
      return
    }

    this.scanning = []

    if (clean) this.keys.removeDataOnly()

    log.debug('KeyManager.rescan:', {clean, keys: this.keys.data.length})

    const marker = '\uFFFD'

    let bench = this.bench('cleanup')
    const ids = []
    const items = await ZoteroDB.queryAsync(`
      SELECT item.itemID, item.libraryID, item.key, extra.value as extra, item.itemTypeID
      FROM items item
      LEFT JOIN itemData field ON field.itemID = item.itemID AND field.fieldID = ${this.query.field.extra}
      LEFT JOIN itemDataValues extra ON extra.valueID = field.valueID
      WHERE item.itemID NOT IN (select itemID from deletedItems)
      AND item.itemTypeID NOT IN (${this.query.type.attachment}, ${this.query.type.note})
    `)
    for (const item of items) {
      ids.push(item.itemID)
      // if no citekey is found, it will be '', which will allow it to be found right after this loop
      const extra = Citekey.get(item.extra)

      // don't fetch when clean is active because the removeDataOnly will have done it already
      const existing = clean ? null : this.keys.findOne({ itemID: item.itemID })
      if (!existing) {
        // if the extra doesn't have a citekey, insert marker, next phase will find & fix it
        this.keys.insert({ citekey: extra.citekey || marker, pinned: extra.pinned, itemID: item.itemID, libraryID: item.libraryID, itemKey: item.key })

      } else if (extra.pinned && ((extra.citekey !== existing.citekey) || !existing.pinned)) {
        // we have an existing key in the DB, extra says it should be pinned to the extra value, but it's not.
        // update the DB to have the itemkey if necessaru
        this.keys.update({ ...existing, citekey: extra.citekey, pinned: true, itemKey: item.key })

      } else if (!existing.itemKey) {
        this.keys.update({ ...existing, itemKey: item.key })
      }
    }

    this.keys.findAndRemove({ itemID: { $nin: ids } })
    this.bench(bench)

    bench = this.bench('regenerate')
    // find all references without citekey
    this.scanning = this.keys.find({ citekey: marker })

    if (this.scanning.length !== 0) {
      log.debug(`KeyManager.rescan: found ${this.scanning.length} references without a citation key`)
      const progressWin = new Zotero.ProgressWindow({ closeOnClick: false })
      progressWin.changeHeadline('Better BibTeX: Assigning citation keys')
      progressWin.addDescription(`Found ${this.scanning.length} references without a citation key`)
      const icon = `chrome://zotero/skin/treesource-unfiled${Zotero.hiDPI ? '@2x' : ''}.png`
      const progress = new progressWin.ItemProgress(icon, 'Assigning citation keys')
      progressWin.show()

      const eta = new ETA(this.scanning.length, { autoStart: true })
      for (let done = 0; done < this.scanning.length; done++) {
        let key = this.scanning[done]
        const item = await getItemsAsync(key.itemID)

        if (key.citekey === marker) {
          if (key.pinned) {
            const parsed = Citekey.get(item.getField('extra'))
            item.setField('extra', parsed.extra)
            await item.saveTx({ [key.itemID]: { bbtCitekeyUpdate: true } })
          }
          key = null
        }

        try {
          this.update(item, key)
        } catch (err) {
          log.error('KeyManager.rescan: update', done, 'failed:', err)
        }

        eta.iterate()

        // tslint:disable-next-line:no-magic-numbers
        if ((done % 10) === 1) {
          // tslint:disable-next-line:no-magic-numbers
          progress.setProgress((eta.done * 100) / eta.count)
          progress.setText(eta.format(`${eta.done} / ${eta.count}, {{etah}} remaining`))
        }
      }

      // tslint:disable-next-line:no-magic-numbers
      progress.setProgress(100)
      progress.setText('Ready')
      // tslint:disable-next-line:no-magic-numbers
      progressWin.startCloseTimer(500)
    }
    this.bench(bench)

    this.scanning = null

    log.debug('KeyManager.rescan: done updating citation keys')
  }

  public update(item, current?) {
    if (item.isNote() || item.isAttachment()) return null

    current = current || this.keys.findOne({ itemID: item.id })

    const proposed = this.propose(item)

    if (current && (current.pinned === proposed.pinned) && (current.citekey === proposed.citekey)) return current.citekey

    if (current) {
      current.pinned = proposed.pinned
      current.citekey = proposed.citekey
      this.keys.update(current)
    } else {
      this.keys.insert({ itemID: item.id, libraryID: item.libraryID, itemKey: item.key, pinned: proposed.pinned, citekey: proposed.citekey })
    }

    return proposed.citekey
  }

  public remove(ids) {
     if (!Array.isArray(ids)) ids = [ids]
     log.debug('KeyManager.remove:', ids)
     this.keys.findAndRemove({ itemID : { $in : ids } })
   }

  public get(itemID) {
    if (typeof itemID !== 'number') throw new Error(`Keymanager.get expects a number, got ${typeof itemID}`)

    // I cannot prevent being called before the init is done because Zotero unlocks the UI *way* before I'm getting the
    // go-ahead to *start* my init.
    if (!this.keys) return { citekey: '', pinned: false, retry: true }

    const key = this.keys.findOne({ itemID })
    if (key) return key

    log.error('KeyManager.get called for non-existent itemID', itemID, new Error('non-existing item'))
    return { citekey: '', pinned: false }
  }

  public propose(item) {
    log.debug('KeyManager.propose: getting existing key from extra field,if any')
    const citekey = Citekey.get(item.getField('extra'))
    log.debug('KeyManager.propose: found key', citekey)

    if (citekey.pinned) return { citekey: citekey.citekey, pinned: true }

    log.debug('KeyManager.propose: formatting...', citekey)
    const proposed = Formatter.format(item)
    log.debug('KeyManager.propose: proposed=', proposed)

    log.debug(`KeyManager.propose: generating free citekey for ${item.id} from`, proposed, { libraryID: item.libraryID })
    const postfix = this[proposed.postfix === '0' ? 'postfixZotero' : 'postfixAlpha']

    const conflictQuery = { libraryID: item.libraryID, itemID: { $ne: item.id } }
    if (Prefs.get('keyScope') === 'global') delete conflictQuery.libraryID

    for (let n = -1; true; n += 1) {
      const postfixed = proposed.citekey + postfix(n)

      const conflict = this.keys.findOne({ ...conflictQuery, citekey: postfixed })
      if (conflict) {
        log.debug(`KeyManager.propose: <${postfixed}> in use by`, conflict)
        continue
      }

      log.debug(`KeyManager.propose: found <${postfixed}> for ${item.id}`)
      return { citekey: postfixed, pinned: false }
    }
  }

  public async tagDuplicates(libraryID) {
    const tag = '#duplicate-citation-key'
    const scope = Prefs.get('keyScope')

    const tagged = (await ZoteroDB.queryAsync(`
      SELECT items.itemID
      FROM items
      JOIN itemTags ON itemTags.itemID = items.itemID
      JOIN tags ON tags.tagID = itemTags.tagID
      WHERE (items.libraryID = ? OR 'global' = ?) AND tags.name = ? AND items.itemID NOT IN (select itemID from deletedItems)
    `, [ libraryID, scope, tag ])).map(item => item.itemID)

    const citekeys: {[key: string]: any[]} = {}
    for (const item of this.keys.find(scope === 'global' ? undefined : { libraryID })) {
      if (!citekeys[item.citekey]) citekeys[item.citekey] = []
      citekeys[item.citekey].push({ itemID: item.itemID, tagged: tagged.includes(item.itemID), duplicate: false })
      if (citekeys[item.citekey].length > 1) citekeys[item.citekey].forEach(i => i.duplicate = true)
    }

    log.debug('tagDuplicates:', {libraryID, scope, tagged, citekeys})

    const mistagged = Object.values(citekeys).reduce((acc, val) => acc.concat(val), []).filter(i => i.tagged !== i.duplicate).map(i => i.itemID)
    for (const item of await getItemsAsync(mistagged)) {
      if (tagged.includes(item.id)) {
        item.removeTag(tag)
      } else {
        item.addTag(tag)
      }

      await item.saveTx()
    }
  }

  private postfixZotero(n) {
    if (n < 0) return ''

    return `-${n + 1}`
  }

  private postfixAlpha(n) {
    if (n < 0) return ''

    const ordA = 'a'.charCodeAt(0)
    const ordZ = 'z'.charCodeAt(0)
    const len = ordZ - ordA + 1

    let postfix = ''
    while (n >= 0) {
      postfix = String.fromCharCode(n % len + ordA) + postfix
      n = Math.floor(n / len) - 1
    }
    return postfix
  }

  private expandSelection(ids) {
    if (Array.isArray(ids)) return ids

    if (ids === 'selected') {
      try {
        return Zotero.getActiveZoteroPane().getSelectedItems(true)
      } catch (err) { // zoteroPane.getSelectedItems() doesn't test whether there's a selection and errors out if not
        log.error('Could not get selected items:', err)
        return []
      }
    }

    return [ids]
  }

  private bench(id) {
    if (typeof id === 'string') return { id, start: Date.now() }
    log.debug('KeyManager.bench:', id.id, Date.now() - id.start)
  }
}
