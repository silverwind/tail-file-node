'use strict'

const fs = require('fs')
const path = require('path')
const {promisify} = require('util')
const {once} = require('events')
const {Transform} = require('stream')
const {test, fail} = require('tap')
const getSymbols = require('./get-symbols.js')
const TailFile = require('../index.js')
const sleep = promisify(setTimeout)

test('Exports structure', async (t) => {
  t.type(TailFile, Function, 'TailFile is a function')
  t.equal(TailFile.name, 'TailFile', 'Class name is correct')

  const methods = Object.getOwnPropertyNames(TailFile.prototype)
  t.same(methods, [
    'constructor'
  , 'start'
  , '_openFile'
  , '_readRemainderFromFileHandle'
  , '_readChunks'
  , '_pollFileForChanges'
  , '_scheduleTimer'
  , '_streamFileChanges'
  , '_read'
  , 'quit'
  ], 'Methods names as expected')

  t.equal(methods.length, 10, 'TailFile.prototype prop count')
})

test('TailFile instantiation', async (t) => {
  const tail = new TailFile(__filename)
  t.equal(tail.constructor.name, 'TailFile', 'instance returned')
})

test('TailFile instance properties', async (t) => {
  t.test('Check Symbol creation and defaults', async (tt) => {
    const tail = new TailFile(__filename)
    const symbols = getSymbols(tail)

    tt.same(tail[symbols.opts], {}, 'opts default values is correct')
    tt.equal(tail[symbols.filename], __filename, 'filename value is correct')
    tt.equal(tail[symbols.pollFileIntervalMs], 1000, 'pollFileIntervalMs value correct')
    tt.equal(tail[symbols.pollFailureRetryMs], 200, 'pollFailureRetryMs value is correct')
    tt.equal(tail[symbols.maxPollFailures], 10, 'maxPollFailures value is correct')
    tt.equal(tail[symbols.pollFailureCount], 0, 'pollFailureCount value is correct')
    tt.equal(tail[symbols.startPos], null, 'startPos value is correct')
    tt.equal(tail[symbols.stream], null, 'stream value is correct')
    tt.equal(tail[symbols.fileHandle], null, 'fileHandle value is correct')
    tt.equal(tail[symbols.pollTimer], null, 'pollTimer value is correct')
    tt.equal(tail[symbols.quitting], false, 'quitting value is correct')
    tt.equal(tail[symbols.inode], null, 'inode value is correct')
  })
})

test('Successfully tail a file using a transform pipe', (t) => {
  const name = 'myLogFile.txt'
  const testDir = t.testdir({
    [name]: 'LINE 1 - This should NOT be consumed when tail starts\n'
  })
  const filename = path.join(testDir, name)
  const output = new Transform({
    transform: function(chunk, encoding, cb) {
      cb(null, chunk)
    }
  , encoding: 'utf8'
  })

  const tail = new TailFile(filename, {
    encoding: 'utf8'
  , pollFileIntervalMs: 10
  })

  t.teardown(() => {
    tail.quit().catch(fail)
  })

  let chunks = ''
  let chunkCount = 0

  tail
    .on('error', t.fail)
    .pipe(output)
    .on('error', t.fail)
    .on('data', (chunk) => {
      chunks += chunk
      t.pass(`Gathering chunk #${++chunkCount}`)
      if (chunks === 'LINE 2\nLINE 3\nLINE 4\n') {
        t.pass('Correct data was consumed from TailFile')
        t.end()
      }
    })

  t.test('Append lines to the file', async (tt) => {
    await tail.start()
    await fs.promises.appendFile(filename, 'LINE 2\n')
    await fs.promises.appendFile(filename, 'LINE 3\n')
    await fs.promises.appendFile(filename, 'LINE 4\n')
  })
})

test('Success: keep tailing a renamed file', async (t) => {
  const name = 'logfile.txt'
  const testDir = t.testdir({
    [name]: 'This is the first line in my log file\n'
  })
  const filename = path.join(testDir, name)
  const tail = new TailFile(filename, {
    encoding: 'utf8'
  , pollFileIntervalMs: 10
  })

  t.teardown(() => {
    tail.quit().catch(fail)
  })

  await tail.start()
  await fs.promises.appendFile(filename, 'Here is line 2')
  const [line2] = await once(tail, 'data')
  t.equal(line2, 'Here is line 2', 'Received line prior to renaming\n')
  await fs.promises.rename(filename, path.join(testDir, `${name}.rolled`))
  await fs.promises.writeFile(filename, 'This line happens after renaming\n')
  const [renamedEvt] = await once(tail, 'renamed')
  t.match(renamedEvt, {
    message: 'The file was renamed or rolled.  Tailing resumed from the beginning.'
  , filename
  , when: Date
  }, 'renamed event is correct')
  const [lineAfterRename] = await once(tail, 'data')
  t.equal(lineAfterRename, 'This line happens after renaming\n')
  await sleep(50) // Tests that there are no changes
  await fs.promises.appendFile(filename, 'Something new')
  const [newLine] = await once(tail, 'data')
  t.equal(newLine, 'Something new', 'Got a line after a period of no changes')
})

test('Success: renaming a file works if the `filename` does not re-appear', async (t) => {
  const name = 'logfile.txt'
  const testDir = t.testdir({
    [name]: ''
  })
  const filename = path.join(testDir, name)
  const tail = new TailFile(filename, {
    encoding: 'utf8'
  , pollFileIntervalMs: 10000000 // We will manually activate polling
  })

  t.teardown(() => {
    tail.quit().catch(fail)
  })

  await tail.start()
  await fs.promises.appendFile(filename, 'Here is line 1\n')
  await fs.promises.appendFile(filename, 'Here is line 2\n')
  await fs.promises.appendFile(filename, 'Here is line 3\n')
  await fs.promises.rename(filename, path.join(testDir, `${name}.rolled`))
  // Manually call poll just to eliminate race conditions with this test
  await tail._pollFileForChanges()
  const [lines] = await once(tail, 'data')
  t.equal(
    lines
  , 'Here is line 1\nHere is line 2\nHere is line 3\n'
  , 'Got lines added in between polls'
  )
})

test('Success: tail file from beginning if it is truncated', async (t) => {
  const name = 'logfile.txt'
  const testDir = t.testdir({
    [name]: 'This is the first line in my log file\n'
  })
  const filename = path.join(testDir, name)

  const tail = new TailFile(filename, {
    encoding: 'utf8'
  , pollFileIntervalMs: 10
  })

  t.teardown(() => {
    tail.quit().catch(fail)
  })

  await tail.start()
  await fs.promises.appendFile(filename, 'Here is line 2')
  const [line2] = await once(tail, 'data')
  t.equal(line2, 'Here is line 2', 'Got line before truncating')
  await fs.promises.truncate(filename)
  const [truncatedEvt] = await once(tail, 'truncated')
  t.match(truncatedEvt, {
    message: 'The file was truncated.  Tailing resumed from the beginning.'
  , filename
  , when: Date
  }, 'Truncated event received')
  await fs.promises.appendFile(
    filename
  , 'This line is in the same file, but at the top\n'
  )
  const [lineAfterTruncate] = await once(tail, 'data')
  t.equal(
    lineAfterTruncate
  , 'This line is in the same file, but at the top\n'
  , 'Line after truncation'
  )
})

test('Success: File may disappear, but continues if the file re-appears', async (t) => {
  const name = 'logfile.txt'
  const testDir = t.testdir({
    [name]: ''
  })
  const filename = path.join(testDir, name)

  const tail = new TailFile(filename, {
    encoding: 'utf8'
  , pollFileIntervalMs: 10
  })

  t.teardown(() => {
    tail.quit().catch(fail)
  })

  await tail.start()
  await fs.promises.unlink(filename)
  await fs.promises.writeFile(filename, 'The file has been re-created\n')
  const [renamedEvt] = await once(tail, 'renamed')
  t.match(renamedEvt, {
    message: 'The file was renamed or rolled.  Tailing resumed from the beginning.'
  , filename
  , when: Date
  }, 'renamed event is correct')
  const [lineAfterRecreate] = await once(tail, 'data')
  t.equal(lineAfterRecreate, 'The file has been re-created\n', 'Got line from new file')
})

test('Success: Stream backpressure is respected for a large file', (t) => {
  const name = 'logfile.txt'

  const testDir = t.testdir({
    [name]: ''
  })
  const filename = path.join(testDir, name)
  const outfile = path.join(testDir, 'clonedfile.txt')

  const tail = new TailFile(filename, {
    encoding: 'utf8'
  , pollFileIntervalMs: 100
  })
  const outputStream = fs.createWriteStream(outfile, {
    encoding: 'utf8'
  })

  t.teardown(() => {
    tail.quit().catch(fail)
  })

  tail.pipe(outputStream)

  let attempts = 0
  setInterval(async function() {
    t.pass(`Comparing logfile.txt to clonedfile.txt: attempt ${++attempts}`)
    const input = await fs.promises.stat(filename)
    const output = await fs.promises.stat(outfile)
    if (input.size === output.size) {
      clearInterval(this)
      t.pass('File successfully cloned')
      t.end()
    }
    if (attempts === 10) t.fail(`File not cloned: ${output.size}/${input.size}`)
  }, 200)

  t.test('Flood the log with large pieces of data', async (tt) => {
    await tail.start()
    let long = ''
    for (let i = 0; i < 10000; i++) {
      long += `This is a line that will be repeated a bunch of times - ${i}\n`
    }
    await fs.promises.appendFile(filename, long)
  })
})

test('Success: Filehandle close NOOPs on error', async (t) => {
  const tail = new TailFile(__filename)
  const symbols = getSymbols(tail)
  await tail.start()
  // Force an error for FH close.  NOTE: this mock is only needed for node 14
  // which does NOT throw an error as in 10 and 12.  Keeps converage at 100% for
  // the matrix.
  tail[symbols.fileHandle] = {
    close: async () => {
      throw new Error('NOPE')
    }
  }
  await tail.quit()
})

test('Success: startPos can be provided to start tailing at a given place', (t) => {
  const name = 'logfile.txt'
  const firstLine = 'This line will be read'
  const secondLine = 'as well as this line'
  const testDir = t.testdir({
    [name]: `${firstLine}\n${secondLine}\n`
  })
  const filename = path.join(testDir, name)

  const tail = new TailFile(filename, {
    encoding: 'utf8'
  , startPos: 0
  })

  t.teardown(() => {
    tail.quit().catch(fail)
  })

  tail.start()

  tail.on('data', (chunk) => {
    if (chunk.includes(firstLine) && chunk.includes(secondLine)) {
      t.pass('The log was successfully tailed from the beginning')
      t.end()
    }
  })
})

test('Error: filename provided does not exist (throws on start)', async (t) => {
  const tail = new TailFile('THISFILEDOSNOTEXIST')
  await t.rejects(tail.start(), {
    name: 'Error'
  , code: 'ENOENT'
  , path: 'THISFILEDOSNOTEXIST'
  , message: /no such file or directory/
  }, 'Expected error is thrown')
})

test('Error: poll error will retry a certain number of times', (t) => {
  t.plan(6) // The retry event listener will assert twice

  const name = 'logfile.txt'
  const testDir = t.testdir({
    [name]: 'This fill will be removed\n'
  })
  const filename = path.join(testDir, name)

  const tail = new TailFile(filename, {
    pollFailureRetryMs: 10
  , maxPollFailures: 3
  })
  const symbols = getSymbols(tail)
  let retries = 0

  tail
    .on('retry', (obj) => {
      t.match(obj, {
        message: 'File disappeared. Retrying.'
      , filename
      , attempts: Number
      , when: Date
      }, 'retry event is correct')
      retries++
    })
    .on('error', (err) => {
      t.type(err, Error, 'error was emitted')
      t.equal(tail[symbols.pollFailureCount], 3, 'Number of retries')
      t.equal(retries, 2, 'Retry event count')
    })

  t.test('Start', async (tt) => {
    await tail.start()
    await fs.promises.unlink(filename)
  })
})

test('Error: _streamFileChanges increments pollFailureCount on failure', (t) => {
  t.plan(3)

  const tail = new TailFile(__filename)
  const symbols = getSymbols(tail)
  tail[symbols.filename] = 'NOPE'
  tail[symbols.startPos] = 0
  tail.on('tail_error', (err) => {
    t.match(err, {
      name: 'Error'
    , message: 'An error was encountered while tailing the file'
    , meta: {
        actual: Error
      }
    }, 'tail_error event emitted')
    t.equal(tail[symbols.pollFailureCount], 1, 'pollFailureCount was incremented')
  })

  t.test('Start', async () => {
    await tail._streamFileChanges()
  })
})

test('Error: Unknown error received during polling causes an exit', (t) => {
  t.plan(2)

  const fsStat = fs.promises.stat

  t.teardown(() => {
    fs.promises.stat = fsStat
  })

  fs.promises.stat = async () => {
    const err = new Error('FS STAT ERROR')
    err.code = 'ENOPE'
    throw err
  }

  const tail = new TailFile(__filename)
    .on('error', (err) => {
      t.type(err, Error, 'Error was returned')
      t.same(err, {
        name: 'Error'
      , message: 'FS STAT ERROR'
      , code: 'ENOPE'
      }, 'The expected error was received')
    })

  tail.start()
})

test('Handled: Error reading remaining file bits emits tail_error', async (t) => {
  const name = 'logfile.txt'
  const testDir = t.testdir({
    [name]: ''
  })
  const filename = path.join(testDir, name)
  const tail = new TailFile(filename, {
    encoding: 'utf8'
  , pollFileIntervalMs: 10000000 // We will manually activate polling
  })
  const symbols = getSymbols(tail)

  t.teardown(() => {
    tail.quit().catch(fail)
  })

  await tail.start()
  await fs.promises.appendFile(filename, 'Here is line 1\n')
  await fs.promises.appendFile(filename, 'Here is line 2\n')
  await fs.promises.appendFile(filename, 'Here is line 3\n')
  await fs.promises.rename(filename, path.join(testDir, `${name}.rolled`))
  // Manually call poll just to eliminate race conditions with this test
  // Close the FH first to trigger an error
  await tail[symbols.fileHandle].close()
  await tail._pollFileForChanges()
  const [evt] = await once(tail, 'tail_error')
  t.match(evt, {
    name: 'Error'
  , code: 'EBADF'
  }, 'Got tail_error as expected')
})

test('Quitting destroys any open tail file stream', (t) => {
  t.plan(4)

  const tail = new TailFile(__filename)
  const symbols = getSymbols(tail)
  tail[symbols.stream] = new fs.createReadStream(__filename)
  tail
    .on('end', () => {
      t.pass('TailFile emitted \'end\' event')
      t.ok(tail[symbols.stream]._readableState.destroyed, 'Underlying stream destroyed')
    })
    .on('flush', () => {
      t.pass('flush event received as expected')
    })

  t.test('Quit', async (tt) => {
    await tail.quit()
  })
})

test('Error: filename is not a string', async (t) => {
  t.throws(() => {
    const tail = new TailFile()
    return tail
  }, {
    name: 'TypeError'
  , message: 'filename must be a non-empty string'
  , code: 'EFILENAME'
  }, 'No filename throws')

  t.throws(() => {
    const tail = new TailFile({})
    return tail
  }, {
    name: 'TypeError'
  , message: 'filename must be a non-empty string'
  , code: 'EFILENAME'
  }, 'Non-string filename throws')

  t.throws(() => {
    const tail = new TailFile(null)
    return tail
  }, {
    name: 'TypeError'
  , message: 'filename must be a non-empty string'
  , code: 'EFILENAME'
  }, 'Null filename throws')

  t.throws(() => {
    const tail = new TailFile('')
    return tail
  }, {
    name: 'TypeError'
  , message: 'filename must be a non-empty string'
  , code: 'EFILENAME'
  }, 'Empty string throws')
})

test('Invalid options checks', async (t) => {
  t.throws(() => {
    const tail = new TailFile(__filename, {pollFileIntervalMs: 'x'})
    return tail
  }, {
    name: 'TypeError'
  , message: 'pollFileIntervalMs must be a number'
  , code: 'EPOLLINTERVAL'
  , meta: {got: 'x'}
  }, 'pollFileIntervalMs throws if not a number')

  t.throws(() => {
    const tail = new TailFile(__filename, {pollFailureRetryMs: 'x'})
    return tail
  }, {
    name: 'TypeError'
  , message: 'pollFailureRetryMs must be a number'
  , code: 'EPOLLRETRY'
  , meta: {got: 'x'}
  }, 'pollFailureRetryMs throws if not a number')

  t.throws(() => {
    const tail = new TailFile(__filename, {maxPollFailures: 'x'})
    return tail
  }, {
    name: 'TypeError'
  , message: 'maxPollFailures must be a number'
  , code: 'EMAXPOLLFAIL'
  , meta: {got: 'x'}
  }, 'maxPollFailures throws if not a number')

  t.throws(() => {
    const tail = new TailFile(__filename, {readStreamOpts: 'x'})
    return tail
  }, {
    name: 'TypeError'
  , message: 'readStreamOpts must be an object'
  , code: 'EREADSTREAMOPTS'
  , meta: {got: 'string'}
  }, 'readStreamOpts throws if not an object')

  t.throws(() => {
    const tail = new TailFile(__filename, {startPos: true})
    return tail
  }, {
    name: 'TypeError'
  , message: 'startPos must be an integer >= 0'
  , code: 'ESTARTPOS'
  , meta: {got: 'boolean'}
  }, 'startPos cannot be a non-number')

  t.throws(() => {
    const tail = new TailFile(__filename, {startPos: -5})
    return tail
  }, {
    name: 'RangeError'
  , message: 'startPos must be an integer >= 0'
  , code: 'ESTARTPOS'
  , meta: {got: -5}
  }, 'startPos must be > 0')

  t.throws(() => {
    const tail = new TailFile(__filename, {startPos: 1.23456})
    return tail
  }, {
    name: 'RangeError'
  , message: 'startPos must be an integer >= 0'
  , code: 'ESTARTPOS'
  , meta: {got: 1.23456}
  }, 'startPos must be > 0')
})
