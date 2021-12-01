const fs = require('fs');
const path = require('path');
const glob = require('glob');
const csv = require('csv-parser');
const cliProgress = require('cli-progress');
const { Worker } = require('worker_threads');

// ---

const NUMBER_OF_WORKERS = process.argv.slice(2)[0] || 2;

glob('*.csv', { nodir: true }, async (err, files) => {
  if (err) {
    console.log('err', err);
    return;
  }

  const filePath = files[0];

  if (files.length > 1) {
    console.warn('Было найдено более 1 .csv файла. Для переименования будет использован только первый найденный = ', filePath);
    console.warn('Все .csv файлы, которые были найдены:');
    console.warn(files.join('\n'));
  }

  const csvData = await new Promise((res) => {
    const results = [];

    fs.createReadStream(filePath)
      .pipe(csv({ separator: ';' }))
      .on('data', (data) => results.push(data))
      .on('end', () => {
        res(results);
      });
  });
  
  const multiBar = new cliProgress.MultiBar({
    clearOnComplete: false,
    hideCursor: true
  }, cliProgress.Presets.shades_grey);

  const chunksCSV = splitToChunks(csvData, NUMBER_OF_WORKERS);

  const comparisonPromises = chunksCSV.map((csvChunk) => {
    const notRenamedImages = [];
    const bar = multiBar.create(csvChunk.length, 0);

    return new Promise((resolve, reject) => {
      const worker = new Worker(getFunctionBody(renameCycle.toString()), {
        eval: true,
        workerData: {
          csvChunk,
        },
      });

      worker.on('message', (value) => {
        if (value.hasOwnProperty('notRenamedImage')) {
          notRenamedImages.push(value.notRenamedImage);
        }

        if (value.message === 'inc') {
          bar.increment();
        }
      });

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }

        resolve(notRenamedImages);
      });
    })
  });

  const notRenamedImages = await Promise.all(comparisonPromises);
  const notRenamedImagesFlatArray = notRenamedImages.flat();

  multiBar.stop();

  if (notRenamedImagesFlatArray.length > 0) {
    console.log('Некоторые картинки не были переименованны (возможно их нет в .csv файле): ');
    console.log(notRenamedImagesFlatArray.join('\n'));
  }
});

function renameCycle() {
  const glob = require('glob');
  const path = require('path');
  const fs = require('fs');
  const { workerData, parentPort } = require('worker_threads');

  const { csvChunk } = workerData;

  for (const data of csvChunk) {
    if (!data.IMAGE || typeof data.IMAGE !== 'string' || !data.ID) {
      parentPort.postMessage({ message: 'inc' });
      continue;
    }

    glob(`images/**/${data.IMAGE}`, { nodir: true }, (err, images) => {
      if (err) {
        console.log('err', err);
        return null;
      }

      const imagePath = images[0];

      if (!imagePath) {
        parentPort.postMessage({ message: 'inc', notRenamedImage: data.IMAGE });
        return null
      }

      const { dir, ext } = path.parse(imagePath);

      const newImagePath = path.join(dir, `${data.ID}${ext}`);

      fs.rename(imagePath, newImagePath, (err) => {
        if (err) {
          console.log('err', err);
        }
        parentPort.postMessage({ message: 'inc' });
      });
    });
  }
}

function splitToChunks(array, chunkSize) {
  const chunkLength = Math.max(array.length / chunkSize, 1);
  const chunks = [];

  for (let i = 0; i < chunkSize; i++) {
    const chunkPosition = chunkLength * (i + 1);

    if (chunkPosition <= array.length) {
      chunks.push(array.slice(chunkLength * i, chunkPosition));
    }
  }

  return chunks;
}

function getFunctionBody(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.substring(
    value.indexOf('{') + 1,
    value.lastIndexOf('}')
  );
}
