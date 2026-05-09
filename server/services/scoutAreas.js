import { config, csv } from '../config.js';

const defaultDistricts = {
  Москва: [
    'ЦАО',
    'САО',
    'СВАО',
    'ВАО',
    'ЮВАО',
    'ЮАО',
    'ЮЗАО',
    'ЗАО',
    'СЗАО',
    'Мещанский район',
    'Таганский район',
    'Пресненский район',
    'Хамовники',
  ],
  Казань: ['Вахитовский район', 'Приволжский район', 'Советский район', 'Московский район', 'Кировский район', 'Ново-Савиновский район', 'Авиастроительный район'],
  Екатеринбург: ['Центр', 'ВИЗ', 'Уралмаш', 'Эльмаш', 'Академический', 'ЖБИ', 'Ботанический', 'Химмаш', 'Втузгородок'],
  Краснодар: ['Центральный округ', 'Западный округ', 'Карасунский округ', 'Прикубанский округ', 'Фестивальный микрорайон', 'Юбилейный микрорайон', 'Гидростроителей'],
};

function configuredDistricts() {
  if (!config.SCOUT_DISTRICTS_JSON) return {};
  try {
    const parsed = JSON.parse(config.SCOUT_DISTRICTS_JSON);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function scoutAreas() {
  const custom = configuredDistricts();
  const cities = csv(config.SCOUT_CITIES);
  return cities.flatMap((city) => {
    const districts = config.SCOUT_AREA_MODE === 'districts' ? custom[city] || defaultDistricts[city] || [] : [];
    const labels = districts.length ? districts : [city];
    return labels.map((area) => ({
      city,
      area,
      queryLocation: area === city ? city : `${area} ${city}`,
    }));
  });
}

export function plannedScoutQueries({ provider = 'google', pageLimit = 1 } = {}) {
  return scoutAreas().length * csv(config.SCOUT_NICHES).length * Math.max(1, Number(pageLimit) || 1);
}
