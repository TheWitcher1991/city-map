const STORAGE_KEY = 'agronote_data';
const PROFILE_KEY = 'agronote_profile';
const SETTINGS_KEY = 'agronote_settings';

let map;
let drawnLayer;
let parcels = [];
let profile = {};
let profileConfigured = false;
let settings = {};
let drawingManager;
let isDrawing = false;
let selectedParcel = null;
let overlappingParcelId = null;

const cultureColors = {
    'Газопровод': '#ef4444', 'ЛЭП': '#f59e0b', 'Водопровод': '#0284c7',
    'Канализация': '#7c3aed', 'Связь': '#0891b2', 'Земельный участок': '#16a34a',
    'Теплосеть': '#ea580c'
};
let drawingType = 'area';
let pendingCoordinates = [];
let lastGeocodeRequestAt = 0;
let locationRequestToken = 0;
const GEOCODE_CACHE_KEY = 'citymap_geocode_cache';
let dialogResolver = null;

const CITIES = {
    stavropol: { name: 'Ставрополь', center: [45.0448, 41.9691], zoom: 12 },
    pyatigorsk: { name: 'Пятигорск', center: [44.0486, 43.0594], zoom: 12 },
    kislovodsk: { name: 'Кисловодск', center: [43.9052, 42.7168], zoom: 12 },
    nevinnomyssk: { name: 'Невинномысск', center: [44.6333, 41.9333], zoom: 12 },
    essentuki: { name: 'Ессентуки', center: [44.0444, 42.8589], zoom: 12 },
    'mineralnye-vody': { name: 'Минеральные Воды', center: [44.2103, 43.1353], zoom: 12 },
    georgievsk: { name: 'Георгиевск', center: [44.1486, 43.4739], zoom: 12 },
    mikhailovsk: { name: 'Михайловск', center: [45.1297, 42.0288], zoom: 12 },
    budyonnovsk: { name: 'Будённовск', center: [44.7814, 44.1658], zoom: 12 },
    izobilny: { name: 'Изобильный', center: [45.3694, 41.7086], zoom: 12 },
    zheleznovodsk: { name: 'Железноводск', center: [44.1394, 43.0197], zoom: 12 },
    svetlograd: { name: 'Светлоград', center: [45.3286, 42.8567], zoom: 12 }
};

document.addEventListener('DOMContentLoaded', function() {
    loadData();
    initMap();
    initDrawing();
    initTabs();
    initNotes();
    initProfile();
    initModals();
    initDialog();
    updateProfileAccess();
    if (!profileConfigured) switchTab('profile');
});

function loadData() {
    const storedParcels = localStorage.getItem(STORAGE_KEY);
    if (storedParcels) {
        parcels = JSON.parse(storedParcels);
        parcels.forEach(parcel => {
            if (parcel.culture === 'ЗУ') parcel.culture = 'Земельный участок';
        });
    }

    const storedProfile = localStorage.getItem(PROFILE_KEY);
    if (storedProfile) {
        profile = JSON.parse(storedProfile);
    }
    profileConfigured = Boolean(profile.fullname?.trim() && profile.position && profile.farm?.trim());

    const storedSettings = localStorage.getItem(SETTINGS_KEY);
    if (storedSettings) {
        settings = JSON.parse(storedSettings);
    } else {
        settings = {
            units: 'meters',
            mapType: 'satellite'
        };
    }
    if (!['meters', 'kilometers'].includes(settings.units)) settings.units = 'meters';
}

function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parcels));
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function initMap() {
    const citySelect = document.getElementById('city-select');
    const savedCity = CITIES[settings.city] ? settings.city : 'stavropol';
    const initialCity = CITIES[savedCity];
    citySelect.value = savedCity;

    map = L.map('map', {
        zoomControl: true
    }).setView(initialCity.center, initialCity.zoom);

    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Esri',
        maxZoom: 19
    });

    const schema = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: 'OpenStreetMap',
        maxZoom: 19
    });

    satellite.addTo(map);

    window.mapLayers = { satellite, schema };
    window.currentLayer = 'satellite';

    document.getElementById('map-type-btn').addEventListener('click', toggleMapType);
    citySelect.addEventListener('change', () => {
        const city = CITIES[citySelect.value];
        if (!city) return;
        settings.city = citySelect.value;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        map.flyTo(city.center, city.zoom, { duration: 0.7 });
    });

    renderParcels();
}

function toggleMapType() {
    const btn = document.getElementById('map-type-btn');
    if (window.currentLayer === 'satellite') {
        window.mapLayers.schema.addTo(map);
        map.removeLayer(window.mapLayers.satellite);
        window.currentLayer = 'schema';
        btn.querySelector('i').className = 'ti ti-map';
    } else {
        window.mapLayers.satellite.addTo(map);
        map.removeLayer(window.mapLayers.schema);
        window.currentLayer = 'satellite';
        btn.querySelector('i').className = 'ti ti-satellite';
    }
}

function renderParcels() {
    if (drawnLayer) {
        map.removeLayer(drawnLayer);
    }

    drawnLayer = L.layerGroup().addTo(map);

    parcels.forEach(parcel => {
        const color = cultureColors[parcel.culture] || '#64748b';
        const isLine = parcel.geometryType === 'line';
        const shape = isLine
            ? L.polyline(parcel.coordinates, { color, weight: 5, opacity: 0.9 })
            : L.polygon(parcel.coordinates, { color, fillColor: color, fillOpacity: 0.3, weight: 2 });

        shape.on('click', function() {
            openParcelModal(parcel);
        });

        shape.on('dblclick', function() {
            openParcelModal(parcel);
        });

        shape.parcelId = parcel.id;
        shape.addTo(drawnLayer);
    });
}

function initDrawing() {
    ['area', 'line'].forEach(type => {
        document.getElementById(`draw-${type === 'area' ? 'area' : 'line'}-btn`).addEventListener('click', function() {
            if (!profileConfigured) return showProfileRequiredNotice();
            const wasDrawing = isDrawing;
            const sameTool = this.classList.contains('active');
            drawingType = type;
            document.querySelectorAll('.draw-tool').forEach(button => button.classList.toggle('active', button === this));
            if (isDrawing) cancelDrawing();
            if (!wasDrawing || !sameTool) startDrawing();
        });
    });

    document.getElementById('finish-drawing-btn').addEventListener('click', finishDrawing);

    map.on('click', function(e) {
        if (profileConfigured && isDrawing && drawingManager && e.originalEvent.detail !== 2) {
            drawingManager.addPoint(e.latlng);
        }
    });

    map.on('dblclick', function(e) {
        if (isDrawing && drawingManager) {
            e.originalEvent.preventDefault();
            finishDrawing();
        }
    });
}

function startDrawing() {
    if (!profileConfigured) return showProfileRequiredNotice();
    isDrawing = true;
    document.getElementById('finish-drawing-btn').hidden = false;
    document.querySelectorAll('.draw-tool').forEach(button => button.classList.toggle('drawing', button.classList.contains('active')));
    
    drawingManager = {
        points: [],
        preview: null,
        markers: [],
        
        addPoint: function(latlng) {
            this.points.push(latlng);
            
            if (this.preview) {
                map.removeLayer(this.preview);
            }
            if (this.points.length > 1) {
                this.preview = this.points.length >= 3 && drawingType === 'area'
                    ? L.polygon(this.points, { color: '#2563eb', fillOpacity: 0.12, dashArray: '5, 8' })
                    : L.polyline(this.points, { color: '#2563eb', weight: 3, dashArray: '5, 8' });
                this.preview.addTo(map);
            }
            this.markers.push(L.circleMarker(latlng, {
                radius: 6,
                color: '#2563eb',
                fillColor: '#2563eb',
                fillOpacity: 1
            }).addTo(map));
        }
    };

    map.getContainer().style.cursor = 'crosshair';
}

function finishDrawing() {
    if (!profileConfigured) return cancelDrawing();
    const minPoints = drawingType === 'line' ? 2 : 3;
    if (drawingManager && drawingManager.points.length >= minPoints) {
        const coordinates = drawingManager.points.map(p => [p.lat, p.lng]);
        const overlaps = drawingType === 'area' ? checkOverlap(coordinates) : [];
        
        if (overlaps.length > 0) {
            overlappingParcelId = overlaps[0].id;
            pendingCoordinates = coordinates;
            openOverlapModal();
            cancelDrawing();
        } else {
            openParcelFormModal(null, coordinates, drawingType);
            cancelDrawing();
        }
    } else {
        showNotice(drawingType === 'line' ? 'Для линии поставьте минимум 2 точки' : 'Для площади поставьте минимум 3 точки', 'Недостаточно точек');
        cancelDrawing();
    }
}

function cancelDrawing() {
    isDrawing = false;
    document.getElementById('finish-drawing-btn').hidden = true;
    document.querySelectorAll('.draw-tool').forEach(button => button.classList.remove('drawing'));
    if (drawingManager) {
        if (drawingManager.preview) map.removeLayer(drawingManager.preview);
        drawingManager.markers.forEach(marker => map.removeLayer(marker));
    }
    
    drawingManager = null;
    map.getContainer().style.cursor = '';
}

function checkOverlap(newCoords) {
    const overlaps = [];
    
    parcels.forEach(parcel => {
        try {
            const existingPoly = L.polygon(parcel.coordinates);
            const newPoly = L.polygon(newCoords);
            
            if (existingPoly.getBounds().intersects(newPoly.getBounds())) {
                overlaps.push({ id: parcel.id });
            }
        } catch(e) {
            console.log('Overlap check error:', e);
        }
    });
    
    return overlaps;
}

function initTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    document.getElementById('open-profile-setup').addEventListener('click', () => switchTab('profile'));
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            const tabId = this.dataset.tab;
            
            tabBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            document.querySelectorAll('.tab-content').forEach(content => {
                content.style.display = 'none';
            });
            
            document.getElementById('tab-' + tabId).style.display = tabId === 'map' ? 'block' : 'flex';
            
            if (tabId === 'notes') {
                renderNotesList();
            }
            
            if (tabId === 'map') {
                setTimeout(() => {
                    map.invalidateSize();
                }, 100);
            }
        });
    });
}

function initNotes() {
    const searchInput = document.getElementById('search-input');
    const filterBtn = document.getElementById('filter-btn');
    const filtersPanel = document.getElementById('filters-panel');
    const applyFilterBtn = document.getElementById('apply-filter');
    const clearFilterBtn = document.getElementById('clear-filter');

    let currentFilters = {
        search: '',
        field: '',
        culture: ''
    };

    filterBtn.addEventListener('click', function() {
        filtersPanel.style.display = filtersPanel.style.display === 'none' ? 'flex' : 'none';
        populateFilterOptions();
    });

    searchInput.addEventListener('input', function(e) {
        currentFilters.search = e.target.value;
        renderNotesList();
    });

    applyFilterBtn.addEventListener('click', function() {
        currentFilters.field = document.getElementById('filter-field').value;
        currentFilters.culture = document.getElementById('filter-culture').value;
        renderNotesList();
    });

    clearFilterBtn.addEventListener('click', function() {
        document.getElementById('filter-field').value = '';
        document.getElementById('filter-culture').value = '';
        currentFilters = { search: '', field: '', culture: '' };
        renderNotesList();
    });
}

function populateFilterOptions() {
    const fieldSelect = document.getElementById('filter-field');
    const cultureSelect = document.getElementById('filter-culture');
    
    const fields = [...new Set(parcels.map(p => p.fieldNumber))];
    const cultures = [...new Set(parcels.map(p => p.culture))];
    
    fieldSelect.innerHTML = '<option value="">Все номера</option>';
    fields.forEach(field => {
        fieldSelect.innerHTML += `<option value="${field}">${field}</option>`;
    });
    
    cultureSelect.innerHTML = '<option value="">Все объекты</option>';
    cultures.forEach(culture => {
        cultureSelect.innerHTML += `<option value="${culture}">${culture}</option>`;
    });
}

function renderNotesList() {
    const notesList = document.getElementById('notes-list');
    const searchValue = document.getElementById('search-input').value.toLowerCase();
    const fieldFilter = document.getElementById('filter-field').value;
    const cultureFilter = document.getElementById('filter-culture').value;

    let filteredParcels = parcels.filter(parcel => {
        const matchesSearch = !searchValue ||
            (parcel.note || '').toLowerCase().includes(searchValue) ||
            String(parcel.fieldNumber || '').toLowerCase().includes(searchValue) ||
            String(parcel.culture || '').toLowerCase().includes(searchValue) ||
            JSON.stringify(parcel.location || {}).toLowerCase().includes(searchValue);
        
        const matchesField = !fieldFilter || parcel.fieldNumber === fieldFilter;
        const matchesCulture = !cultureFilter || parcel.culture === cultureFilter;
        
        return matchesSearch && matchesField && matchesCulture;
    });

    filteredParcels.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (filteredParcels.length === 0) {
        notesList.innerHTML = `<div class="empty-state"><i class="ti ti-search-off"></i><p>${parcels.length ? 'Объекты не найдены' : 'Объектов пока нет'}</p></div>`;
        return;
    }

    notesList.innerHTML = filteredParcels.map(parcel => {
        const date = new Date(parcel.createdAt).toLocaleDateString('ru-RU');
        const preview = (parcel.note || 'Без описания').substring(0, 60) + ((parcel.note || '').length > 60 ? '...' : '');
        
        return `
            <div class="note-card" data-id="${parcel.id}">
                <div class="note-card-header">
                    <span class="note-field"><i class="ti ti-number"></i> № ${parcel.fieldNumber}</span>
                    <span class="note-date"><i class="ti ti-calendar"></i> ${date}</span>
                </div>
                <div class="note-culture"><i class="ti ti-building-community"></i> ${parcel.culture}${parcel.geometryType === 'line' ? ` · ${formatLength(parcel.coordinates)}` : ''}</div>
                ${parcel.location?.city ? `<div class="note-location"><i class="ti ti-map-pin"></i>${escapeHtml(parcel.location.city)}${parcel.location.district ? ` · ${escapeHtml(parcel.location.district)}` : ''}</div>` : ''}
                <div class="note-preview">${preview}</div>
            </div>
        `;
    }).join('');

    document.querySelectorAll('.note-card').forEach(card => {
        card.addEventListener('click', function() {
            const parcelId = this.dataset.id;
            const parcel = parcels.find(p => p.id === parcelId);
            
            if (parcel) {
                switchTab('map');
                setTimeout(() => {
                const bounds = L.polyline(parcel.coordinates).getBounds();
                    map.fitBounds(bounds, { padding: [50, 50] });
                    openParcelModal(parcel);
                }, 150);
            }
        });
    });
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.tab === tabName) {
            btn.classList.add('active');
        }
    });

    document.querySelectorAll('.tab-content').forEach(content => {
        content.style.display = 'none';
    });

    document.getElementById('tab-' + tabName).style.display = tabName === 'map' ? 'block' : 'flex';

    if (tabName === 'map') {
        setTimeout(() => map.invalidateSize(), 100);
    }
}

function initProfile() {
    document.getElementById('fullname').value = profile.fullname || '';
    document.getElementById('position').value = ['Инженер', 'Специалист', 'Руководитель'].includes(profile.position) ? profile.position : 'Инженер';
    document.getElementById('farm').value = profile.farm || '';
    document.getElementById('units').value = settings.units || 'meters';
    document.getElementById('default-map-type').value = settings.mapType || 'satellite';

    document.getElementById('change-avatar-btn').addEventListener('click', function() {
        if (!profileConfigured) return showProfileRequiredNotice();
        document.getElementById('avatar-input').click();
    });

    document.getElementById('avatar-input').addEventListener('change', function(e) {
        if (!profileConfigured) return;
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(event) {
                const avatarPreview = document.getElementById('avatar-preview');
                avatarPreview.innerHTML = `<img src="${event.target.result}" alt="Avatar">`;
                profile.avatar = event.target.result;
                saveData();
            };
            reader.readAsDataURL(file);
        }
    });

    if (profile.avatar) {
        const avatarPreview = document.getElementById('avatar-preview');
        avatarPreview.innerHTML = `<img src="${profile.avatar}" alt="Avatar">`;
    }

    document.getElementById('profile-form').addEventListener('submit', function(e) {
        e.preventDefault();
        if (!this.reportValidity()) return;
        const fullname = document.getElementById('fullname').value.trim();
        const organization = document.getElementById('farm').value.trim();
        if (!fullname || !organization) {
            showNotice('ФИО и организация не должны быть пустыми.', 'Заполните профиль');
            return;
        }

        profile.fullname = fullname;
        profile.position = document.getElementById('position').value;
        profile.farm = organization;
        profile.isConfigured = true;
        profileConfigured = true;
        
        settings.units = document.getElementById('units').value;
        settings.mapType = document.getElementById('default-map-type').value;
        
        saveData();
        updateProfileAccess();
        showNotice('Профиль сохранён. Теперь можно добавлять и редактировать объекты.');
    });

    document.getElementById('clear-cache-btn').addEventListener('click', function() {
        if (!profileConfigured) return showProfileRequiredNotice();
        showDialog({
            title: 'Очистить кэш карт?',
            message: 'Сохранённые на этом устройстве тайлы карт будут удалены.',
            confirm: true,
            destructive: true,
            confirmText: 'Очистить'
        }).then(confirmed => {
            if (!confirmed) return;
            localStorage.removeItem('leaflet_cache');
            showNotice('Кэш карт очищен');
        });
    });

    document.getElementById('logout-btn').addEventListener('click', function() {
        if (!profileConfigured) return;
        showDialog({
            title: 'Выйти из профиля?',
            message: 'Данные профиля будут сброшены на этом устройстве.',
            confirm: true,
            destructive: true,
            confirmText: 'Выйти'
        }).then(confirmed => {
            if (!confirmed) return;
            profile = {};
            profileConfigured = false;
            saveData();
            location.reload();
        });
    });
}

function updateProfileAccess() {
    const locked = !profileConfigured;
    document.getElementById('profile-lock-banner').hidden = !locked;
    document.getElementById('profile-setup-notice').hidden = !locked;
    document.querySelectorAll('.draw-tool').forEach(button => {
        button.disabled = locked;
        button.title = locked ? 'Сначала заполните профиль' : button.getAttribute('aria-label');
    });
    document.getElementById('avatar-input').disabled = locked;
    document.getElementById('change-avatar-btn').disabled = locked;
    document.querySelectorAll('.settings-group select, .settings-group button').forEach(control => { control.disabled = locked; });
    document.getElementById('logout-btn').hidden = locked;
    document.getElementById('parcel-actions').hidden = locked;
    document.getElementById('parcel-readonly-hint').hidden = !locked;
}

function showProfileRequiredNotice() {
    showNotice('Сначала заполните и сохраните профиль. Пароль не требуется.', 'Только просмотр');
}

function initModals() {
    const parcelModal = document.getElementById('parcel-modal');
    const viewModal = document.getElementById('view-parcel-modal');
    const overlapModal = document.getElementById('overlap-modal');

    document.getElementById('culture').addEventListener('change', () => updateInfrastructureMeasurements(true));

    document.getElementById('close-modal').addEventListener('click', function() {
        parcelModal.classList.remove('active');
    });

    document.getElementById('cancel-parcel').addEventListener('click', function() {
        parcelModal.classList.remove('active');
    });

    document.getElementById('close-view-modal').addEventListener('click', function() {
        viewModal.classList.remove('active');
    });

    document.getElementById('close-overlap-modal').addEventListener('click', function() {
        overlapModal.classList.remove('active');
    });

    document.getElementById('cancel-overlap').addEventListener('click', function() {
        overlapModal.classList.remove('active');
    });

    document.getElementById('edit-existing').addEventListener('click', function() {
        const parcel = parcels.find(p => p.id === overlappingParcelId);
        if (parcel) {
            openParcelFormModal(parcel, parcel.coordinates, parcel.geometryType);
        }
        overlapModal.classList.remove('active');
    });

    document.getElementById('create-new').addEventListener('click', function() {
        openParcelFormModal(null, pendingCoordinates, 'area');
        overlapModal.classList.remove('active');
    });

    document.getElementById('note').addEventListener('input', function() {
        document.getElementById('char-count').textContent = this.value.length;
    });

    document.getElementById('parcel-form').addEventListener('submit', function(e) {
        e.preventDefault();
        saveParcel();
    });

    document.getElementById('lookup-location-btn').addEventListener('click', function() {
        const coords = JSON.parse(document.getElementById('parcel-coords').value || '[]');
        this.disabled = true;
        this.innerHTML = '<i class="ti ti-loader-2"></i> Определяем…';
        lookupLocation(coords).finally(() => {
            this.disabled = false;
            this.innerHTML = '<i class="ti ti-crosshair"></i> Обновить';
        });
    });

    document.getElementById('delete-parcel').addEventListener('click', function() {
        if (!profileConfigured) return showProfileRequiredNotice();
        if (!selectedParcel) return;
        showDialog({
            title: 'Удалить объект?',
            message: 'Объект и его заметка будут удалены с карты.',
            confirm: true,
            destructive: true,
            confirmText: 'Удалить'
        }).then(confirmed => {
            if (!confirmed || !selectedParcel) return;
            parcels = parcels.filter(p => p.id !== selectedParcel.id);
            saveData();
            renderParcels();
            document.getElementById('view-parcel-modal').classList.remove('active');
            showNotice('Объект удалён');
        });
    });

    document.getElementById('edit-parcel').addEventListener('click', function() {
        if (!profileConfigured) return showProfileRequiredNotice();
        if (selectedParcel) {
            document.getElementById('view-parcel-modal').classList.remove('active');
            openParcelFormModal(selectedParcel, selectedParcel.coordinates, selectedParcel.geometryType);
        }
    });
}

function openParcelFormModal(parcel, coords, geometryType = 'area') {
    if (!profileConfigured) return showProfileRequiredNotice();
    locationRequestToken++;
    const modal = document.getElementById('parcel-modal');
    const form = document.getElementById('parcel-form');
    
    form.reset();
    document.getElementById('char-count').textContent = '0';
    
    if (parcel) {
        document.getElementById('modal-title').textContent = 'Редактирование объекта';
        document.getElementById('parcel-id').value = parcel.id;
        document.getElementById('field-number').value = parcel.fieldNumber;
        document.getElementById('culture').value = parcel.culture;
        document.getElementById('diameter').value = parcel.diameter ?? '';
        document.getElementById('burial-depth').value = parcel.burialDepth ?? '';
        document.getElementById('note').value = parcel.note || '';
        document.getElementById('char-count').textContent = (parcel.note || '').length;
        document.getElementById('parcel-location').value = JSON.stringify(parcel.location || null);
    } else {
        document.getElementById('modal-title').textContent = 'Новый объект';
        document.getElementById('parcel-id').value = '';
        document.getElementById('parcel-location').value = '';
    }

    updateInfrastructureMeasurements(true);
    
    document.getElementById('parcel-coords').value = JSON.stringify(coords || []);
    document.getElementById('geometry-type').value = geometryType || 'area';
    
    modal.classList.add('active');
    if (parcel?.location) {
        renderLocation(parcel.location);
    } else if (!parcel) {
        renderLocation(null, 'Адрес ещё не определён');
    } else {
        renderLocation(null, 'Место не определено');
    }
}

function updateInfrastructureMeasurements(clearHidden) {
    const selectedType = document.getElementById('culture').value;
    const showMeasurements = Boolean(selectedType) && !['ЗУ', 'Земельный участок'].includes(selectedType);
    document.querySelectorAll('.infrastructure-measurement').forEach(group => { group.hidden = !showMeasurements; });
    if (!showMeasurements && clearHidden) {
        document.getElementById('diameter').value = '';
        document.getElementById('burial-depth').value = '';
    }
}

function renderLocation(location, fallback = 'Не удалось определить адрес') {
    const label = document.getElementById('location-label');
    const container = document.getElementById('location-info');
    container.classList.toggle('loading', fallback === 'Определяем место…');
    if (!location) {
        label.textContent = fallback;
        return;
    }
    const parts = [location.city, location.district, location.street, location.house].filter(Boolean);
    label.textContent = parts.join(', ') || location.displayName || 'Адрес не найден';
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function getLocationCache() {
    try { return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || '{}'); }
    catch { return {}; }
}

function getRepresentativePoint(coords, geometryType) {
    if (!coords.length) return null;
    const layer = geometryType === 'line' ? L.polyline(coords) : L.polygon(coords);
    const center = layer.getBounds().getCenter();
    return [center.lat, center.lng];
}

async function lookupLocation(coords) {
    const point = getRepresentativePoint(coords, document.getElementById('geometry-type').value);
    if (!point) {
        renderLocation(null, 'Место не определено');
        return;
    }
    const token = ++locationRequestToken;
    renderLocation(null, 'Определяем место…');
    const cache = getLocationCache();
    const cacheKey = point.map(value => value.toFixed(5)).join(',');
    if (cache[cacheKey]) {
        document.getElementById('parcel-location').value = JSON.stringify(cache[cacheKey]);
        renderLocation(cache[cacheKey]);
        return;
    }
    try {
        const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeRequestAt));
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        if (token !== locationRequestToken) return;
        lastGeocodeRequestAt = Date.now();
        const query = new URLSearchParams({
            format: 'jsonv2', addressdetails: '1', zoom: '18',
            lat: String(point[0]), lon: String(point[1]), 'accept-language': 'ru'
        });
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${query}`);
        if (!response.ok) throw new Error(`Geocoder returned ${response.status}`);
        const result = await response.json();
        const address = result.address || {};
        const location = {
            city: address.city || address.town || address.village || address.municipality || address.county || '',
            region: address.state || address.state_district || '',
            district: address.city_district || address.district || address.borough || address.suburb || address.neighbourhood || '',
            street: address.road || address.residential || address.pedestrian || '',
            house: address.house_number || '',
            displayName: result.display_name || ''
        };
        if (!location.city && !location.region && !location.street) throw new Error('No address details');
        cache[cacheKey] = location;
        const keys = Object.keys(cache);
        if (keys.length > 80) delete cache[keys[0]];
        try { localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache)); }
        catch (storageError) { console.warn('Could not cache map location:', storageError); }
        if (token === locationRequestToken) {
            document.getElementById('parcel-location').value = JSON.stringify(location);
            renderLocation(location);
        }
    } catch (error) {
        console.warn('Could not resolve map location:', error);
        if (token === locationRequestToken) renderLocation(null, 'Адрес не определён · можно сохранить без него');
    }
}

function saveParcel() {
    if (!profileConfigured) return showProfileRequiredNotice();
    const id = document.getElementById('parcel-id').value;
    const coords = JSON.parse(document.getElementById('parcel-coords').value);
    const readMeasurement = elementId => {
        const raw = document.getElementById(elementId).value.trim().replace(',', '.');
        if (!raw) return '';
        const value = Number(raw);
        return Number.isFinite(value) && value >= 0 ? value : '';
    };
    
    const parcelData = {
        id: id || Date.now().toString(),
        fieldNumber: document.getElementById('field-number').value,
        culture: document.getElementById('culture').value,
        diameter: readMeasurement('diameter'),
        burialDepth: readMeasurement('burial-depth'),
        geometryType: document.getElementById('geometry-type').value,
        location: JSON.parse(document.getElementById('parcel-location').value || 'null'),
        note: document.getElementById('note').value,
        coordinates: coords,
        createdAt: id ? parcels.find(p => p.id === id)?.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    if (!parcelData.fieldNumber || !parcelData.culture) {
        showNotice('Укажите номер и выберите тип инфраструктурного объекта.', 'Заполните обязательные поля');
        return;
    }

    if (id) {
        const index = parcels.findIndex(p => p.id === id);
        if (index !== -1) {
            parcels[index] = parcelData;
        }
    } else {
        parcels.push(parcelData);
    }

    saveData();
    renderParcels();
    document.getElementById('parcel-modal').classList.remove('active');
}

function openParcelModal(parcel) {
    selectedParcel = parcel;
    const modal = document.getElementById('view-parcel-modal');
    const details = document.getElementById('parcel-details');
    
    const createdDate = new Date(parcel.createdAt).toLocaleDateString('ru-RU');
    const updatedDate = parcel.updatedAt ? new Date(parcel.updatedAt).toLocaleDateString('ru-RU') : '-';
    
    details.innerHTML = `
        <div class="parcel-detail-item">
            <label><i class="ti ti-number"></i> Номер</label>
            <span>№ ${parcel.fieldNumber}</span>
        </div>
        <div class="parcel-detail-item">
            <label><i class="ti ti-building-community"></i> Объект инфраструктуры</label>
            <span class="culture-badge"><i class="ti ti-building-community"></i> ${parcel.culture}</span>
        </div>
        ${parcel.diameter !== '' && parcel.diameter != null || parcel.burialDepth !== '' && parcel.burialDepth != null ? `<div class="parcel-detail-item"><label><i class="ti ti-ruler-measure"></i> Параметры</label><span>${parcel.diameter !== '' && parcel.diameter != null ? `Диаметр ${parcel.diameter} мм` : ''}${parcel.diameter !== '' && parcel.diameter != null && parcel.burialDepth !== '' && parcel.burialDepth != null ? ' · ' : ''}${parcel.burialDepth !== '' && parcel.burialDepth != null ? `Глубина заложения ${parcel.burialDepth} м` : ''}</span></div>` : ''}
        <div class="parcel-detail-item"><label><i class="ti ti-route"></i> Геометрия</label><span>${parcel.geometryType === 'line' ? `Линия · ${formatLength(parcel.coordinates)}` : 'Площадь'}</span></div>
        ${parcel.location ? `<div class="parcel-detail-item"><label><i class="ti ti-map-pin"></i> Местоположение</label><span>${escapeHtml([parcel.location.city, parcel.location.district, parcel.location.street, parcel.location.house].filter(Boolean).join(', ') || parcel.location.displayName || '—')}${parcel.location.region ? `<br>${escapeHtml(parcel.location.region)}` : ''}</span></div>` : ''}
        <div class="parcel-detail-item">
            <label><i class="ti ti-notes"></i> Заметка</label>
            <span>${parcel.note || '—'}</span>
        </div>
        <div class="parcel-detail-item">
            <label><i class="ti ti-calendar-plus"></i> Дата создания</label>
            <span>${createdDate}</span>
        </div>
        <div class="parcel-detail-item">
            <label><i class="ti ti-calendar-edit"></i> Последнее изменение</label>
            <span>${updatedDate}</span>
        </div>
    `;
    
    modal.classList.add('active');
}

function openOverlapModal() {
    document.getElementById('overlap-modal').classList.add('active');
}

function showNotice(message, title = 'Готово') {
    return showDialog({ title, message });
}

function showDialog({ title, message, confirm = false, destructive = false, confirmText = 'Подтвердить' }) {
    const modal = document.getElementById('dialog-modal');
    const cancelButton = document.getElementById('dialog-cancel');
    const acceptButton = document.getElementById('dialog-accept');
    const icon = document.getElementById('dialog-icon');
    document.getElementById('dialog-title').textContent = title;
    document.getElementById('dialog-message').textContent = message;
    cancelButton.hidden = !confirm;
    acceptButton.textContent = confirmText === 'Подтвердить' && !confirm ? 'Понятно' : confirmText;
    acceptButton.classList.toggle('dialog-destructive', destructive);
    icon.classList.toggle('destructive', destructive);
    icon.innerHTML = `<i class="ti ${destructive ? 'ti-alert-triangle' : 'ti-info-circle'}"></i>`;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    acceptButton.focus();
    return new Promise(resolve => { dialogResolver = resolve; });
}

function closeDialog(result) {
    const modal = document.getElementById('dialog-modal');
    if (!modal.classList.contains('active')) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    const resolve = dialogResolver;
    dialogResolver = null;
    if (resolve) resolve(result);
}

function initDialog() {
    document.getElementById('dialog-accept').addEventListener('click', () => closeDialog(true));
    document.getElementById('dialog-cancel').addEventListener('click', () => closeDialog(false));
    const modal = document.getElementById('dialog-modal');
    modal.addEventListener('click', event => {
        if (event.target === modal) closeDialog(false);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeDialog(false);
    });
}

function formatLength(coords) {
    const meters = (coords || []).slice(1).reduce((sum, point, index) => {
        const previous = coords[index];
        const toRad = value => value * Math.PI / 180;
        const dLat = toRad(point[0] - previous[0]);
        const dLng = toRad(point[1] - previous[1]);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(previous[0])) * Math.cos(toRad(point[0])) * Math.sin(dLng / 2) ** 2;
        return sum + 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }, 0);
    const units = settings.units || 'meters';
    return units === 'kilometers' ? `${(meters / 1000).toFixed(2)} км` : `${Math.round(meters)} м`;
}
