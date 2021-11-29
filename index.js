const fs = require('fs');
const path = require('path');
const glob = require('glob');
const csv = require('csv-parser');

// ---

glob('*.csv', { nodir: true }, async (err, files) => {
  if (err) {
    console.log('err', err);
    return;
  }

  const filePath = files[0];

  if (files.length > 1) {
    console.warn('Было найдено более 1 .csv файла. Для переименования будет использован только первый найденный = ', filePath);
    console.warn('Все .csv файлы, которые были найдены:\n', files.join('\n'));
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

  const globPromises = [];

  csvData.forEach((data) => {
    if (!data.IMAGE || typeof data.IMAGE !== 'string' || !data.ID) {
      return;
    }

    const promise = new Promise((res, rej) => {
      glob(`images/**/${data.IMAGE}`, { nodir: true }, async (err, images) => {
        if (err) {
          console.log('err', err);
          rej(err);
          return;
        }

        const imagePath = images[0];

        if (!imagePath) {
          console.log('Не найдена картинка с именем: ', data.IMAGE);
          return;
        }

        const { dir, ext } = path.parse(imagePath);

        const newImagePath = path.join(dir, `${data.ID}${ext}`);

        res({ imagePath, newImagePath });
      });
    });

    globPromises.push(promise);
  });

  const newNames = await Promise.all(globPromises);

  newNames.forEach((names) => {
    fs.renameSync(names.imagePath, names.newImagePath);
  });
});
