(function phoneInputModule(global) {
  'use strict';

  let catalogPromise = null;

  function normalizeSearch(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  function optionLabel(item) {
    return `${item.name} (+${item.callingCode})`;
  }

  function findCountry(countries, value) {
    const query = normalizeSearch(value);
    if (!query) return null;
    const matches = countries.filter((item) => {
      const candidates = [optionLabel(item), item.name, item.code, item.callingCode, `+${item.callingCode}`];
      return candidates.some((candidate) => normalizeSearch(candidate) === query);
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function filterCountries(countries, value, limit = 8) {
    const query = normalizeSearch(value).replace(/^\+/, '');
    if (!query) return countries.slice(0, limit);
    return countries
      .map((item) => {
        const name = normalizeSearch(item.name);
        const code = normalizeSearch(item.code);
        const lada = normalizeSearch(item.callingCode);
        let score = 99;
        if (code === query) score = -3;
        else if (lada === query) score = -2;
        else if (name === query) score = -1;
        else if (name.startsWith(query)) score = 0;
        else if (code.startsWith(query)) score = 1;
        else if (lada.startsWith(query)) score = 2;
        else if (name.includes(query)) score = 3;
        return { item, score };
      })
      .filter((entry) => entry.score < 99)
      .sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name, 'es'))
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  function loadCatalog() {
    if (!catalogPromise) {
      catalogPromise = fetch('/api/auth/phone-countries')
        .then((res) => {
          if (!res.ok) throw new Error('No se pudo cargar la lista de países');
          return res.json();
        });
    }
    return catalogPromise;
  }

  function localeCountry() {
    const locale = String(navigator.language || '').split('-');
    return locale[1] ? locale[1].toUpperCase() : '';
  }

  async function setup(options) {
    const country = document.getElementById(options.countryId);
    const callingCode = document.getElementById(options.callingCodeId);
    const phone = document.getElementById(options.phoneId);
    if (!country || !callingCode || !phone) return;

    country.disabled = true;
    const payload = await loadCatalog();
    const countries = Array.isArray(payload.countries) ? payload.countries : [];
    if (!countries.length) throw new Error('La lista de países está vacía');
    const preferred = [options.defaultCountry, localeCountry(), payload.defaultCountry, 'MX']
      .map((value) => String(value || '').toUpperCase())
      .find((value) => countries.some((item) => item.code === value)) || countries[0]?.code || 'MX';

    country.innerHTML = countries.map((item) =>
      `<option value="${item.code}" data-calling-code="${item.callingCode}">${optionLabel(item)}</option>`
    ).join('');
    country.value = preferred;

    const autocomplete = document.createElement('div');
    const search = document.createElement('input');
    const suggestions = document.createElement('div');
    const hint = document.createElement('div');
    const searchId = `${country.id}Search`;
    const suggestionsId = `${country.id}Suggestions`;
    autocomplete.className = 'phone-country-autocomplete';
    search.type = 'search';
    search.id = searchId;
    search.setAttribute('autocomplete', 'off');
    search.setAttribute('spellcheck', 'false');
    search.setAttribute('placeholder', 'Buscar país o lada, ej. México o +52');
    search.setAttribute('aria-label', 'Buscar país o lada internacional');
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-autocomplete', 'list');
    search.setAttribute('aria-controls', suggestionsId);
    search.setAttribute('aria-expanded', 'false');
    search.required = true;
    suggestions.id = suggestionsId;
    suggestions.className = 'phone-country-suggestions';
    suggestions.setAttribute('role', 'listbox');
    suggestions.hidden = true;
    autocomplete.append(search, suggestions);
    country.insertAdjacentElement('afterend', autocomplete);
    hint.className = 'hint';
    hint.textContent = 'Escribe el país, su código (MX) o su lada (+52) y elige una sugerencia.';
    autocomplete.insertAdjacentElement('afterend', hint);
    country.hidden = true;
    country.disabled = false;
    country.required = false;
    country._phoneCountrySearch = search;
    country._phoneCountries = countries;
    const label = document.querySelector(`label[for="${country.id}"]`);
    if (label) label.htmlFor = searchId;

    const syncCallingCode = () => {
      const selected = countries.find((item) => item.code === country.value);
      callingCode.value = selected?.callingCode ? `+${selected.callingCode}` : '';
      phone.setAttribute('aria-label', `Número telefónico de ${selected?.name || 'país seleccionado'}`);
    };

    let visibleCountries = [];
    let activeIndex = -1;

    const closeSuggestions = () => {
      suggestions.hidden = true;
      search.setAttribute('aria-expanded', 'false');
      search.removeAttribute('aria-activedescendant');
      activeIndex = visibleCountries.length ? 0 : -1;
    };

    const selectCountry = (selected) => {
      if (!selected) return;
      country.value = selected.code;
      search.value = optionLabel(selected);
      syncCallingCode();
      closeSuggestions();
    };

    const paintActiveSuggestion = () => {
      suggestions.querySelectorAll('[data-country-index]').forEach((button, index) => {
        const active = index === activeIndex;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        if (active) {
          search.setAttribute('aria-activedescendant', button.id);
          button.scrollIntoView({ block: 'nearest' });
        }
      });
    };

    const renderSuggestions = (query = search.value) => {
      visibleCountries = filterCountries(countries, query, 10);
      activeIndex = -1;
      suggestions.replaceChildren();
      if (!visibleCountries.length) {
        const empty = document.createElement('div');
        empty.className = 'phone-country-empty';
        empty.textContent = 'No encontramos un país con ese texto o lada.';
        suggestions.append(empty);
      } else {
        visibleCountries.forEach((item, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.id = `${suggestionsId}-${index}`;
          button.dataset.countryIndex = String(index);
          button.setAttribute('role', 'option');
          button.setAttribute('aria-selected', 'false');
          const name = document.createElement('span');
          const countryName = document.createElement('b');
          const countryCode = document.createElement('small');
          countryName.textContent = item.name;
          countryCode.textContent = item.code;
          name.append(countryName, countryCode);
          const lada = document.createElement('strong');
          lada.textContent = `+${item.callingCode}`;
          button.append(name, lada);
          button.addEventListener('mousedown', (event) => event.preventDefault());
          button.addEventListener('click', () => selectCountry(item));
          suggestions.append(button);
        });
      }
      suggestions.hidden = false;
      search.setAttribute('aria-expanded', 'true');
      if (activeIndex >= 0) paintActiveSuggestion();
    };

    const preferredCountry = countries.find((item) => item.code === preferred) || countries[0];
    country.value = preferredCountry.code;
    search.value = optionLabel(preferredCountry);
    search.addEventListener('focus', () => {
      search.select();
      renderSuggestions('');
    });
    search.addEventListener('input', () => {
      const exact = findCountry(countries, search.value);
      country.value = exact?.code || '';
      syncCallingCode();
      renderSuggestions(search.value);
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (suggestions.hidden) renderSuggestions(search.value);
        if (!visibleCountries.length) return;
        activeIndex = event.key === 'ArrowDown'
          ? (activeIndex + 1) % visibleCountries.length
          : (activeIndex <= 0 ? visibleCountries.length - 1 : activeIndex - 1);
        paintActiveSuggestion();
      } else if (event.key === 'Enter' && !suggestions.hidden && activeIndex >= 0) {
        event.preventDefault();
        selectCountry(visibleCountries[activeIndex]);
      } else if (event.key === 'Tab' && !suggestions.hidden && visibleCountries.length === 1) {
        selectCountry(visibleCountries[0]);
      } else if (event.key === 'Escape') {
        closeSuggestions();
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!autocomplete.contains(event.target)) closeSuggestions();
    });
    syncCallingCode();
  }

  function values(options) {
    const phone = String(document.getElementById(options.phoneId)?.value || '').trim();
    const country = document.getElementById(options.countryId);
    const phoneCountry = String(country?.value || '').trim().toUpperCase();
    if (!phoneCountry) {
      country?._phoneCountrySearch?.focus();
      throw new Error('Selecciona un país válido de la lista');
    }
    const rawDigits = phone.replace(/\D/g, '');
    const digits = rawDigits.startsWith('00') ? rawDigits.slice(2) : rawDigits;
    if (digits.length < 4 || digits.length > 15) throw new Error('El número está incompleto o es demasiado largo');
    if (/^(\d)\1+$/.test(digits) || /^(0123456789|1234567890|9876543210|0987654321)$/.test(digits) || /^(.{1,3})\1{2,}$/.test(digits)) {
      throw new Error('Ingresa un teléfono real; no se permiten números repetidos o secuenciales');
    }
    return { phone, phoneCountry };
  }

  global.CBPPhoneInput = { filterCountries, findCountry, setup, values };
})(window);
