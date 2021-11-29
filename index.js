const fs = require('fs');
const path = require('path');
const glob = require('glob');
const csv = require('csv-parser');
const cliProgress = require('cli-progress');

// ---

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
  
  const chunksCSV = splitByChunks(csvData, 1000);

  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(csvData.length, 0);

  const notRenamedImages = [];

  for (const csvData of chunksCSV) {
    const globPromises = [];

    csvData.forEach((data) => {
      if (!data.IMAGE || typeof data.IMAGE !== 'string' || !data.ID) {
        bar.increment();
        return null;
      }

      const images = glob.sync(`images/**/${data.IMAGE}`, { nodir: true });

      const imagePath = images[0];

      if (!imagePath) {
        bar.increment();
        notRenamedImages.push(data.IMAGE);
        return;
      }

      const { dir, ext } = path.parse(imagePath);

      const newImagePath = path.join(dir, `${data.ID}${ext}`);

      bar.increment();
      fs.renameSync(imagePath, newImagePath);
    });
  }

  bar.stop();
  
  if (notRenamedImages.length > 0) {
    console.log('Некоторые картинки не были переименованны (возможно их нет в .csv файле): ');
    console.log(notRenamedImages.join('\n'));
  }
});

function splitByChunks(files, chunks) {
  const tempArray = [];

  for (let i = 0; i < files.length; i += chunks) {
    tempArray.push(files.slice(i, i + chunks));
  }

  return tempArray;
}
