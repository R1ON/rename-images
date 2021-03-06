const fs = require('fs');
const fse = require('fs-extra');
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
    console.warn('----------');
    console.warn('Было найдено более 1 .csv файла. Для переименования будет использован только первый найденный = ', filePath);
    console.warn('Все .csv файлы, которые были найдены:');
    console.warn(files.join('\n'));
    console.warn('----------');
    console.log('\n');
  }

  console.log('Проверяю CSV файл...');

  const csvData = await new Promise((res) => {
    const results = [];

    fs.createReadStream(filePath)
      .pipe(csv({ separator: ';' }))
      .on('data', (data) => results.push(data))
      .on('end', () => {
        res(results);
      });
  });

  let repeatingCSV = new Map();
  const uniqCSVImagePath = [];

  const uniqCSV = csvData.reduce((acc, csv) => {
    if (uniqCSVImagePath.includes(csv.IMAGE)) {
      const prevValue = repeatingCSV.get(csv.IMAGE) || [];

      repeatingCSV.set(csv.IMAGE, [...prevValue, csv]);
    }
    else {
      uniqCSVImagePath.push(csv.IMAGE);
      acc.push(csv);
    }

    return acc;
  }, []);
  
  if (repeatingCSV.size > 0) {
    console.warn('==========');
    console.log('Были найдены повторяющиеся записи в CSV файле. Количество повторов: ', repeatingCSV.size);
    console.log('Будет создан файл repeatingCSV.txt куда были вынесены все повторы');
    console.log('На каждый повторяющийся файл будет создана дополнительная картинка');
    console.warn('==========');
    console.log('\n');

    const csv = [];

    repeatingCSV.forEach((value) => {
      value.forEach((csvData) => {
        csv.push(JSON.stringify(csvData));
      });
    });

    fs.writeFile('repeatingCSV.txt', csv.join('\n'), (err) => {
      if (err) {
        console.log('Не получилось создать repeatingCSV.txt файл');
        console.log('err', err);
        return;
      }

      console.log('Файл repeatingCSV.txt создан');
    });
  }

  console.log('Начинаю сканировать картинки...');
  glob(`images/**/*`, { nodir: true }, async (err, images) => {
    if (err) {
      console.log('err', err);
      return null;
    }

    console.log('Было найдено картинок:', images.length);
    console.log('Идет подготовка картинок для обработки...');

    const imagesWithInfo = images.map((image) => {
      const { name, ext, dir } = path.parse(image);

      return ({
        ext,
        dir,
        name: `${name}${ext}`,
        fullPath: image,
      });
    });

    console.log('Подготовка завершена');

    const multiBar = new cliProgress.MultiBar({
      clearOnComplete: false,
      hideCursor: true
    }, cliProgress.Presets.shades_grey);

    const chunksCSV = splitToChunks(uniqCSV, NUMBER_OF_WORKERS);

    const comparisonPromises = chunksCSV.map((csvChunk) => {
      const notRenamedImages = [];
      const usedImages = [];
      const bar = multiBar.create(csvChunk.length, 0);

      return new Promise((resolve, reject) => {
        const worker = new Worker(getFunctionBody(renameCycle.toString()), {
          eval: true,
          workerData: {
            csvChunk,
            images: imagesWithInfo,
            repeatingCSV,
          },
        });

        worker.on('message', (value) => {
          if (value.hasOwnProperty('notRenamedImage')) {
            notRenamedImages.push(value.notRenamedImage);
          }

          if (value.hasOwnProperty('image')) {
            usedImages.push(value.image);
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

          resolve({ notRenamedImages, usedImages });
        });
      })
    });

    const comparisonData = await Promise.all(comparisonPromises);

    const notRenamedImages = comparisonData.map((data) => data.notRenamedImages).flat();

    multiBar.stop();

    if (notRenamedImages.length > 0) {
      console.warn('----------');
      console.log('Некоторые картинки, которые были указаны в .csv не были найдена (возможно их нет в папке images)');
      console.log('Будет создан notRenamedImages.txt');
      console.warn('----------');
      console.log('\n');

      fs.writeFile('notRenamedImages.txt', notRenamedImages.join('\n'), (err) => {
        if (err) {
          console.log('Не получилось создать notRenamedImages.txt файл');
          console.log('err', err);
          return;
        }

        console.log('Файл notRenamedImages.txt создан');
      });
    }

    const usedImages = comparisonData.map((data) => data.usedImages).flat();

    const notUsedImages = imagesWithInfo.filter((image) => {
      return !usedImages.find((usedImage) => usedImage.fullPath === image.fullPath);
    });

    if (notUsedImages.length > 0) {
      const dir = 'NOT_USED_IMAGES';

      console.warn('----------');
      console.warn('Были найдены лишние картинки, которые не указаны в CSV файле.');
      console.warn('Они будут перемещены в папку ', dir);
      console.warn('----------');

      if (!fs.existsSync(dir)){
        fs.mkdirSync(dir);
      }

      const promises = notUsedImages.map((image) => {
        const newPath = image.fullPath.replace('images/', `${dir}/`);

        return fse.move(image.fullPath, newPath);
      });

      await Promise.all(promises);
    }
  });
});

function renameCycle() {
  const path = require('path');
  const fs = require('fs');
  const { workerData, parentPort } = require('worker_threads');

  const { csvChunk, images, repeatingCSV } = workerData;

  for (const data of csvChunk) {
    if (!data.IMAGE || typeof data.IMAGE !== 'string' || !data.ID) {
      parentPort.postMessage({ message: 'inc' });
      continue;
    }

    const image = images.find((image) => image.name === data.IMAGE);

    if (!image) {
      parentPort.postMessage({ message: 'inc', notRenamedImage: data.IMAGE });
      continue;
    }
    
    const promises = [];

    if (repeatingCSV.has(data.IMAGE)) {
      const csvData = repeatingCSV.get(data.IMAGE);

      csvData.forEach((value) => {
        const newImagePath = path.join(image.dir, `${value.ID}${image.ext}`);
        promises.push(fs.promises.copyFile(image.fullPath, newImagePath));
      });
    }

    const newImagePath = path.join(image.dir, `${data.ID}${image.ext}`);
    
    Promise.all(promises).then(() => {
      fs.rename(image.fullPath, newImagePath, (err) => {
        if (err) {
          console.log('image', image);
          console.log('newImagePath', newImagePath);
          console.log('err', err);
        }

        parentPort.postMessage({ message: 'inc', image });
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
