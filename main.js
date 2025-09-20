import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getFirestore, collection, query, where, orderBy, limit, getDocs, doc, updateDoc, increment, addDoc, serverTimestamp, getDoc, startAfter, deleteDoc } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

let db;
let auth;
let quill;
let lastVisibleLatest = null;
let lastVisiblePolitics = null;
let lastVisibleCategory = null;
const articlesPerPage = 6;
const maxRetries = 3;

// Firebase configuration using environment variables
const firebaseConfig = {
  apiKey: window.env?.VITE_FIREBASE_API_KEY || '',
  authDomain: window.env?.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: window.env?.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: window.env?.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: window.env?.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: window.env?.VITE_FIREBASE_APP_ID || '',
  measurementId: window.env?.VITE_FIREBASE_MEASUREMENT_ID || '',
};

// Initialize Firebase
async function initializeFirebase() {
  try {
    if (!window.env?.VITE_FIREBASE_API_KEY) {
      throw new Error("Firebase API key is missing. Ensure environment variables are set in Netlify (VITE_FIREBASE_*) or in your HTML script tag.");
    }
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    console.log('Firebase initialized successfully');
  } catch (error) {
    console.error('Firebase initialization failed:', error.message);
    displayErrorMessage('body', 'Failed to connect to the database. Check your Firebase environment variables in Netlify or refresh the page.');
  }
}

// Display error messages
function displayErrorMessage(selector, message) {
  const element = document.querySelector(selector);
  if (element) {
    const errorDiv = document.createElement('div');
    errorDiv.classList.add('error-message');
    errorDiv.innerHTML = `
      ${message}
      <button class="dismiss-error" aria-label="Dismiss error">✖</button>
    `;
    element.appendChild(errorDiv);
    errorDiv.querySelector('.dismiss-error').addEventListener('click', () => errorDiv.remove());
  }
}

// Retry logic for Firebase operations
async function withRetry(fn, retries = maxRetries, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      console.warn(`Retry ${attempt} failed:`, error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Validate URLs
function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// Format timestamp for display
function formatTimestamp(timestamp) {
  try {
    if (!timestamp) {
      console.warn('Timestamp is null or undefined');
      return 'Date Unavailable';
    }
    if (timestamp.toDate && typeof timestamp.toDate === 'function') {
      const date = timestamp.toDate();
      if (isNaN(date.getTime())) {
        console.warn('Invalid Firestore Timestamp:', timestamp);
        return 'Date Unavailable';
      }
      return date.toLocaleDateString();
    }
    console.warn('Timestamp does not have toDate method:', timestamp);
    return 'Date Unavailable';
  } catch (error) {
    console.error('Error formatting timestamp:', error.message, 'Timestamp:', timestamp);
    return 'Date Unavailable';
  }
}

// Initialize Quill editor and ripple effect
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('article-content-input') && typeof Quill !== 'undefined') {
    quill = new Quill('#article-content-input', {
      theme: 'snow',
      modules: {
        toolbar: [
          [{ 'header': [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ 'color': [] }, { 'background': [] }],
          [{ 'list': 'ordered' }, { 'list': 'bullet' }],
          ['link', 'image'],
          ['clean']
        ]
      }
    });
  }

  // Ripple effect for buttons and links
  document.querySelectorAll('.ripple-btn').forEach(element => {
    element.addEventListener('click', function (e) {
      if (element.disabled) return;
      const rect = element.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const ripple = document.createElement('span');
      ripple.classList.add('ripple');
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      const diameter = Math.max(rect.width, rect.height);
      ripple.style.width = ripple.style.height = `${diameter}px`;
      element.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    });
  });
});

// Load articles for homepage
async function loadArticles() {
  if (!db) {
    displayErrorMessage('.content', 'Unable to load articles: Database not initialized. Check Firebase configuration in Netlify.');
    return;
  }
  const sections = [
    { selector: '.breaking-news-card', collection: 'articles', limit: 1, filter: { breakingNews: true }, orderBy: { field: 'createdAt', direction: 'desc' } },
    { selector: '.fact-check-card', collection: 'articles', limit: 2, filter: { category: 'fact-check', verified: true } }
  ];

  for (const { selector, collection: coll, limit: lim, filter, orderBy: sort } of sections) {
    const elements = document.querySelectorAll(selector);
    let q = query(collection(db, coll));
    if (filter) {
      if (filter.breakingNews) {
        q = query(q, where('breakingNews', '==', true));
      } else {
        q = query(q, where('category', '==', filter.category));
        if (filter.verified) q = query(q, where('verified', '==', true));
      }
    }
    if (sort) q = query(q, orderBy(sort.field, sort.direction));
    q = query(q, limit(lim));
    try {
      console.log(`Executing query for ${selector} with filter:`, filter, 'orderBy:', sort);
      const snapshot = await withRetry(() => getDocs(q));
      console.log(`Loaded ${snapshot.size} articles for ${selector}`, snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      if (snapshot.empty) {
        console.warn(`No articles found for ${selector} with filter:`, filter);
        if (selector === '.breaking-news-card') {
          console.log('No breaking news articles found, attempting fallback to latest article');
          let fallbackQuery = query(collection(db, 'articles'), orderBy('createdAt', 'desc'), limit(1));
          const fallbackSnapshot = await withRetry(() => getDocs(fallbackQuery));
          console.log(`Fallback query loaded ${fallbackSnapshot.size} articles`, fallbackSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
          if (!fallbackSnapshot.empty) {
            const article = fallbackSnapshot.docs[0].data();
            const docId = fallbackSnapshot.docs[0].id;
            const element = elements[0];
            if (element && element.dataset.placeholder === 'true') {
              element.dataset.id = docId;
              const link = element.querySelector('.article-link');
              const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
              console.log(`Rendering fallback breaking news article ID: ${docId}, Image URL: ${imageUrl}, CreatedAt:`, article.createdAt);
              const img = link.querySelector('img');
              img.src = '';
              img.src = imageUrl;
              img.alt = article.title || 'Article Image';
              img.srcset = `${imageUrl} 400w, ${imageUrl} 200w`;
              img.sizes = '(max-width: 767px) 200px, 400px';
              img.onerror = () => {
                console.warn(`Fallback image failed to load for article ID: ${docId}, URL: ${imageUrl}`);
                img.src = 'https://via.placeholder.com/400x200';
                img.srcset = 'https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w';
                img.sizes = '(max-width: 767px) 200px, 400px';
              };
              img.onload = () => {
                console.log(`Fallback image loaded successfully for article ID: ${docId}, URL: ${img.src}`);
                img.style.display = 'block';
              };
              link.setAttribute('href', `article.html?id=${docId}`);
              link.querySelector('h2, h3').textContent = article.title || 'Untitled Article';
              link.querySelector('p').textContent = article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available');
              const timeElement = link.querySelector('.article-time') || document.createElement('p');
              timeElement.classList.add('article-time');
              timeElement.textContent = `Posted: ${formatTimestamp(article.createdAt)}`;
              if (!link.querySelector('.article-time')) {
                link.appendChild(timeElement);
              }
              const writerElement = link.querySelector('.article-writer') || document.createElement('p');
              writerElement.classList.add('article-writer', 'premium-writer');
              writerElement.textContent = `By ${article.writer || 'Anonymous'}`;
              if (!link.querySelector('.article-writer')) {
                link.insertBefore(writerElement, timeElement);
              }
              const badge = element.querySelector('.breaking-news-badge');
              if (badge) badge.style.display = 'none';
              element.dataset.placeholder = 'false';
            }
          } else {
            console.warn('No fallback articles available for breaking news');
            elements.forEach(element => {
              element.innerHTML = '<p>No breaking news available at this time.</p>';
              element.dataset.placeholder = 'false';
            });
          }
        } else {
          elements.forEach(element => {
            element.innerHTML = '<p>No articles available.</p>';
            element.dataset.placeholder = 'false';
          });
        }
        continue;
      }
      let index = 0;
      snapshot.forEach(doc => {
        const article = doc.data();
        const element = elements[index];
        if (element && element.dataset.placeholder === 'true') {
          element.dataset.id = doc.id;
          const link = element.querySelector('.article-link');
          const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
          console.log(`Rendering ${selector} article ID: ${doc.id}, Image URL: ${imageUrl}, CreatedAt:`, article.createdAt);
          const img = link.querySelector('img');
          img.src = '';
          img.src = imageUrl;
          img.alt = article.title || 'Article Image';
          img.srcset = `${imageUrl} 400w, ${imageUrl} 200w`;
          img.sizes = '(max-width: 767px) 200px, 400px';
          img.onerror = () => {
            console.warn(`Image failed to load for article ID: ${doc.id}, URL: ${imageUrl}`);
            img.src = 'https://via.placeholder.com/400x200';
            img.srcset = 'https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w';
            img.sizes = '(max-width: 767px) 200px, 400px';
          };
          img.onload = () => {
            console.log(`Image loaded successfully for article ID: ${doc.id}, URL: ${img.src}`);
            img.style.display = 'block';
          };
          link.setAttribute('href', `article.html?id=${doc.id}`);
          link.querySelector('h2, h3').textContent = article.title || 'Untitled Article';
          link.querySelector('p').textContent = article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available');
          const timeElement = link.querySelector('.article-time') || document.createElement('p');
          timeElement.classList.add('article-time');
          timeElement.textContent = `Posted: ${formatTimestamp(article.createdAt)}`;
          if (!link.querySelector('.article-time')) {
            link.appendChild(timeElement);
          }
          const writerElement = link.querySelector('.article-writer') || document.createElement('p');
          writerElement.classList.add('article-writer', 'premium-writer');
          writerElement.textContent = `By ${article.writer || 'Anonymous'}`;
          if (!link.querySelector('.article-writer')) {
            link.insertBefore(writerElement, timeElement);
          }
          if (article.breakingNews && element.classList.contains('breaking-news-card')) {
            let badge = element.querySelector('.breaking-news-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.classList.add('breaking-news-badge');
              badge.textContent = 'Breaking News';
              link.appendChild(badge);
            }
            badge.style.display = 'block';
          } else {
            const badge = element.querySelector('.breaking-news-badge');
            if (badge) badge.style.display = 'none';
          }
          if (article.verified && element.classList.contains('fact-check-card')) {
            let badge = element.querySelector('.verified-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.classList.add('verified-badge');
              badge.textContent = 'Verified';
              link.appendChild(badge);
            }
            badge.style.display = 'block';
          } else {
            const badge = element.querySelector('.verified-badge');
            if (badge) badge.style.display = 'none';
          }
          element.dataset.placeholder = 'false';
          index++;
        }
      });
      while (index < elements.length) {
        elements[index].innerHTML = '<p>No articles available.</p>';
        elements[index].dataset.placeholder = 'false';
        index++;
      }
    } catch (error) {
      console.error(`Error loading ${selector}:`, error.message, error.code);
      let errorMessage = `Failed to load articles for ${selector}: ${error.message}. `;
      if (error.code === 'permission-denied') {
        errorMessage += 'Check Firestore security rules to ensure public read access to the "articles" collection.';
      } else if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
        errorMessage += 'Network issue detected. Check your internet connection or Netlify configuration.';
      } else {
        errorMessage += 'Verify the Firestore "articles" collection or try refreshing the page.';
      }
      displayErrorMessage(selector, errorMessage);
    }
  }

  const breakingNewsQuery = query(collection(db, 'articles'), where('breakingNews', '==', true), orderBy('createdAt', 'desc'), limit(1));
  try {
    const snapshot = await withRetry(() => getDocs(breakingNewsQuery));
    if (!snapshot.empty) {
      const article = snapshot.docs[0].data();
      const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/1200x630';
      console.log('Breaking news meta image:', imageUrl);
      document.querySelector('meta[property="og:title"]').setAttribute('content', `Naija Truths - ${article.title || 'Breaking News'}`);
      document.querySelector('meta[name="description"]').setAttribute('content', article.summary || (article.content ? article.content.substring(0, 160) : 'Breaking news from Naija Truths'));
      document.querySelector('meta[property="og:description"]').setAttribute('content', article.summary || (article.content ? article.content.substring(0, 160) : 'Breaking news from Naija Truths'));
      document.querySelector('meta[property="og:image"]').setAttribute('content', imageUrl);
      document.title = `Naija Truths - ${article.title || 'Breaking News'}`;
    }
  } catch (error) {
    console.error('Error updating meta tags:', error.message);
  }
}

// Load politics articles
async function loadPoliticsArticles() {
  const politicsArticles = document.getElementById('politics-articles');
  if (!db || !politicsArticles) return;

  lastVisiblePolitics = null;
  politicsArticles.innerHTML = '';
  await fetchPoliticsArticles(true);
}

async function fetchPoliticsArticles(reset = false) {
  const politicsArticles = document.getElementById('politics-articles');
  const loadMoreButton = document.querySelector('.latest-news .load-more-button');
  if (!db || !politicsArticles) return;

  if (reset) {
    lastVisiblePolitics = null;
    politicsArticles.innerHTML = '';
  }

  let q = query(
    collection(db, 'articles'),
    where('category', '==', 'politics'),
    orderBy('createdAt', 'desc'),
    limit(articlesPerPage)
  );
  if (lastVisiblePolitics) q = query(q, startAfter(lastVisiblePolitics));

  try {
    const snapshot = await withRetry(() => getDocs(q));
    if (snapshot.empty && politicsArticles.innerHTML === '') {
      politicsArticles.innerHTML = '<p>No politics articles found.</p>';
      if (loadMoreButton) loadMoreButton.style.display = 'none';
      return;
    }

    snapshot.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('article');
      articleElement.classList.add('news-card');
      articleElement.dataset.id = doc.id;
      const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
      console.log(`Politics article ID: ${doc.id}, Image URL: ${imageUrl}`);
      articleElement.innerHTML = `
        <a href="article.html?id=${doc.id}" class="article-link">
          <img src="${imageUrl}" 
               srcset="${imageUrl} 400w, ${imageUrl} 200w" 
               sizes="(max-width: 767px) 200px, 400px" 
               alt="${article.title || 'Article Image'}" 
               loading="lazy"
               onerror="this.src='https://via.placeholder.com/400x200'; this.srcset='https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w'; this.sizes='(max-width: 767px) 200px, 400px';">
          <h3>${article.title || 'Untitled Article'}</h3>
          <p class="article-writer premium-writer">By ${article.writer || 'Anonymous'}</p>
          <p>${article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available')}</p>
          <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
          ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
          ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        </a>
      `;
      politicsArticles.appendChild(articleElement);
    });

    lastVisiblePolitics = snapshot.docs[snapshot.docs.length - 1];
    if (loadMoreButton) loadMoreButton.style.display = snapshot.size < articlesPerPage ? 'none' : 'block';
  } catch (error) {
    console.error('Error loading politics articles:', error.message);
    displayErrorMessage('#politics-articles', 'Failed to load politics articles. Please try again.');
  }
}

// Load latest news articles
async function loadLatestNewsArticles(category = '') {
  const latestNewsArticles = document.getElementById('latest-news-articles');
  const loadMoreButton = document.querySelector('.latest-news .load-more-button');
  if (!db || !latestNewsArticles) return;

  lastVisibleLatest = null;
  latestNewsArticles.innerHTML = '';
  await fetchLatestNewsArticles(true, loadMoreButton, category);
}

async function fetchLatestNewsArticles(reset = false, loadMoreButton, category = '') {
  const latestNewsArticles = document.getElementById('latest-news-articles');
  if (!db || !latestNewsArticles) return;

  if (reset) {
    lastVisibleLatest = null;
    latestNewsArticles.innerHTML = '';
  }

  let q = query(
    collection(db, 'articles'),
    orderBy('createdAt', 'desc'),
    limit(articlesPerPage)
  );
  if (category) {
    q = query(
      collection(db, 'articles'),
      where('category', '==', category),
      orderBy('createdAt', 'desc'),
      limit(articlesPerPage)
    );
  }
  if (lastVisibleLatest) q = query(q, startAfter(lastVisibleLatest));

  try {
    const snapshot = await withRetry(() => getDocs(q));
    if (snapshot.empty && latestNewsArticles.innerHTML === '') {
      latestNewsArticles.innerHTML = '<p>No articles found.</p>';
      if (loadMoreButton) loadMoreButton.style.display = 'none';
      return;
    }

    snapshot.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('article');
      articleElement.classList.add('news-card');
      articleElement.dataset.id = doc.id;
      const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
      console.log(`Latest news article ID: ${doc.id}, Image URL: ${imageUrl}`);
      articleElement.innerHTML = `
        <a href="article.html?id=${doc.id}" class="article-link">
          <img src="${imageUrl}" 
               srcset="${imageUrl} 400w, ${imageUrl} 200w" 
               sizes="(max-width: 767px) 200px, 400px" 
               alt="${article.title || 'Article Image'}" 
               loading="lazy"
               onerror="this.src='https://via.placeholder.com/400x200'; this.srcset='https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w'; this.sizes='(max-width: 767px) 200px, 400px';">
          <h3>${article.title || 'Untitled Article'}</h3>
          <p class="article-writer premium-writer">By ${article.writer || 'Anonymous'}</p>
          <p>${article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available')}</p>
          <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
          ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
          ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        </a>
      `;
      latestNewsArticles.appendChild(articleElement);
    });

    lastVisibleLatest = snapshot.docs[snapshot.docs.length - 1];
    if (loadMoreButton) loadMoreButton.style.display = snapshot.size < articlesPerPage ? 'none' : 'block';
  } catch (error) {
    console.error('Error loading latest news articles:', error.message);
    displayErrorMessage('#latest-news-articles', 'Failed to load articles. Please try again.');
  }
}
// Load category articles
async function loadCategoryArticles() {
  const urlParams = new URLSearchParams(window.location.search);
  const category = urlParams.get('cat');
  console.log('Category from URL:', category);

  if (!db) {
    console.error('Database not initialized');
    displayErrorMessage('#category-articles', 'Unable to load articles: Database not initialized. Check Firebase configuration in Netlify.');
    return;
  }

  if (!category) {
    console.error('No category provided in URL');
    displayErrorMessage('#category-articles', 'No category specified in the URL. Please select a category from the navigation.');
    return;
  }

  const categoryTitle = document.getElementById('category-title');
  const categoryArticles = document.getElementById('category-articles');
  if (!categoryTitle || !categoryArticles) {
    console.error('Category title or articles container not found');
    displayErrorMessage('.category-section', 'Page elements missing. Check the HTML structure of category.html.');
    return;
  }

  const formattedCategory = category
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' & ');
  categoryTitle.textContent = formattedCategory;
  document.title = `Naija Truths - ${formattedCategory}`;
  document.querySelector('meta[name="description"]').setAttribute('content', `Explore ${formattedCategory} news on Naija Truths.`);
  document.querySelector('meta[property="og:title"]').setAttribute('content', `Naija Truths - ${formattedCategory}`);
  document.querySelector('meta[property="og:description"]').setAttribute('content', `Explore ${formattedCategory} news on Naija Truths.`);
  document.querySelector('meta[property="og:image"]').setAttribute('content', 'https://via.placeholder.com/1200x630');

  lastVisibleCategory = null;
  categoryArticles.innerHTML = '<p>Loading articles...</p>';
  await fetchCategoryArticles(category, true);
}

async function fetchCategoryArticles(category, reset = false) {
  const categoryArticles = document.getElementById('category-articles');
  const loadMoreButton = document.querySelector('.category-section .load-more-button');
  if (!db || !categoryArticles) {
    console.error('Database or category articles container not initialized');
    displayErrorMessage('#category-articles', 'Unable to load articles: Database or page elements not initialized.');
    return;
  }

  if (reset) {
    lastVisibleCategory = null;
    categoryArticles.innerHTML = '';
  }

  let q = query(
    collection(db, 'articles'),
    where('category', '==', category),
    orderBy('createdAt', 'desc'),
    limit(articlesPerPage)
  );
  if (lastVisibleCategory) q = query(q, startAfter(lastVisibleCategory));

  try {
    console.log(`Fetching articles for category: ${category}`);
    const snapshot = await withRetry(() => getDocs(q));
    console.log(`Found ${snapshot.size} articles for category: ${category}`);

    if (snapshot.empty && categoryArticles.innerHTML === '') {
      console.warn(`No articles found for category: ${category}`);
      categoryArticles.innerHTML = '<p>No articles found in this category. Check if articles exist in Firestore with category "${category}".</p>';
      if (loadMoreButton) loadMoreButton.style.display = 'none';
      return;
    }

    snapshot.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('article');
      articleElement.classList.add('news-card');
      articleElement.dataset.id = doc.id;
      const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200';
      console.log(`Rendering article ID: ${doc.id}, Title: ${article.title}, Image URL: ${imageUrl}`);
      articleElement.innerHTML = `
        <a href="article.html?id=${doc.id}" class="article-link">
          <img src="${imageUrl}" 
               srcset="${imageUrl} 400w, ${imageUrl} 200w" 
               sizes="(max-width: 767px) 200px, 400px" 
               alt="${article.title || 'Article Image'}" 
               loading="lazy"
               onerror="this.src='https://via.placeholder.com/400x200'; this.srcset='https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w'; this.sizes='(max-width: 767px) 200px, 400px';">
          <h3>${article.title || 'Untitled Article'}</h3>
          <p class="article-writer premium-writer">By ${article.writer || 'Anonymous'}</p>
          <p>${article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available')}</p>
          <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
          ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
          ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        </a>
      `;
      categoryArticles.appendChild(articleElement);
    });

    lastVisibleCategory = snapshot.docs[snapshot.docs.length - 1];
    if (loadMoreButton) loadMoreButton.style.display = snapshot.size < articlesPerPage ? 'none' : 'block';
  } catch (error) {
    console.error('Error loading category articles:', error.message, error.code);
    let errorMessage = `Failed to load articles for category "${category}": ${error.message}. `;
    if (error.code === 'permission-denied') {
      errorMessage += 'Check Firestore security rules to ensure public read access to the "articles" collection.';
    } else if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
      errorMessage += 'Network issue detected. Check your internet connection and try again.';
    } else {
      errorMessage += `Verify that articles exist in Firestore with category "${category}" or try refreshing the page.`;
    }
    displayErrorMessage('#category-articles', errorMessage);
  }
}

// Load individual article
async function loadArticle() {
  const urlParams = new URLSearchParams(window.location.search);
  const articleId = urlParams.get('id');
  console.log('Attempting to load article with ID:', articleId);
  if (!db) {
    console.error('Database not initialized');
    displayErrorMessage('#article-content', 'Unable to load article: Database not initialized. Please check your Firebase configuration or internet connection.');
    return;
  }
  if (!articleId) {
    console.error('No article ID provided in URL');
    displayErrorMessage('#article-content', 'No article ID provided in the URL. Please select an article from the homepage or check the link.');
    return;
  }

  const docRef = doc(db, 'articles', articleId);
  try {
    const docSnap = await withRetry(() => getDoc(docRef));
    if (docSnap.exists()) {
      const article = docSnap.data();
      console.log('Article loaded successfully:', article.title, 'Verified:', article.verified, 'Breaking News:', article.breakingNews, 'Image:', article.image);

      const articleTitle = document.getElementById('article-title');
      const articleMeta = document.getElementById('article-meta');
      const articleImage = document.getElementById('article-image');
      const articleVideo = document.getElementById('article-video');
      const articleBreakingNews = document.getElementById('article-breaking-news');
      const articleVerified = document.getElementById('article-verified');
      const articleContent = document.getElementById('article-content');
      const articleCard = document.querySelector('.article-card');
      const likeCount = document.getElementById('like-count');

      if (!articleTitle || !articleMeta || !articleContent || !articleCard || !likeCount) {
        console.error('One or more required DOM elements are missing');
        displayErrorMessage('#article-content', 'Failed to load article: Page elements are missing. Please check the HTML structure.');
        return;
      }

      articleTitle.textContent = article.title || 'Untitled Article';
      document.querySelector('meta[property="og:title"]').setAttribute('content', article.title || 'Naija Truths Article');
      document.querySelector('meta[name="description"]').setAttribute('content', article.summary || (article.content ? article.content.substring(0, 160) : 'Article from Naija Truths'));
      document.querySelector('meta[property="og:description"]').setAttribute('content', article.summary || (article.content ? article.content.substring(0, 160) : 'Article from Naija Truths'));
      const imageUrl = article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/1200x630';
      document.querySelector('meta[property="og:image"]').setAttribute('content', imageUrl);
      document.title = `Naija Truths - ${article.title || 'Article'}`;

      if (articleImage) {
        if (article.image && isValidUrl(article.image)) {
          articleImage.src = article.image;
          articleImage.srcset = `${article.image} 1200w, ${article.image} 768w, ${article.image} 480w`;
          articleImage.sizes = '(max-width: 480px) 100vw, (max-width: 768px) 80vw, 800px';
          articleImage.alt = article.title || 'Article Image';
          articleImage.style.display = 'block';
          articleImage.onerror = () => {
            console.warn(`Article image failed to load for ID: ${articleId}, URL: ${article.image}`);
            articleImage.src = 'https://via.placeholder.com/800x400';
            articleImage.srcset = 'https://via.placeholder.com/400x200 480w, https://via.placeholder.com/800x400 768w, https://via.placeholder.com/1200x600 1200w';
            articleImage.sizes = '(max-width: 480px) 100vw, (max-width: 768px) 80vw, 800px';
            articleImage.style.display = 'block';
          };
        } else {
          articleImage.src = 'https://via.placeholder.com/800x400';
          articleImage.srcset = 'https://via.placeholder.com/400x200 480w, https://via.placeholder.com/800x400 768w, https://via.placeholder.com/1200x600 1200w';
          articleImage.sizes = '(max-width: 480px) 100vw, (max-width: 768px) 80vw, 800px';
          articleImage.alt = 'Article Image';
          articleImage.style.display = 'block';
        }
      } else {
        console.warn('Article image element not found');
      }

      articleMeta.textContent = `By ${article.writer || 'Anonymous'} on ${formatTimestamp(article.createdAt)}`;
      articleMeta.classList.add('premium-writer');

      if (articleContent) {
        articleContent.innerHTML = article.content || 'No content available';
      }

      if (articleVideo) {
        if (article.video && isValidUrl(article.video)) {
          articleVideo.src = article.video;
          articleVideo.style.display = 'block';
        } else {
          articleVideo.style.display = 'none';
        }
      } else {
        console.warn('Article video element not found');
      }

      if (articleBreakingNews) {
        articleBreakingNews.style.display = article.breakingNews ? 'block' : 'none';
      } else {
        console.warn('Breaking news badge element not found');
      }

      if (articleVerified) {
        articleVerified.style.display = article.verified ? 'block' : 'none';
      } else {
        console.warn('Verified badge element not found');
      }

      articleCard.dataset.id = articleId;
      likeCount.textContent = article.likes || 0;

      await withRetry(() => updateDoc(docRef, { views: increment(1) }));
      loadComments(articleId);
    } else {
      console.error('Article not found in Firestore for ID:', articleId);
      displayErrorMessage('#article-content', `Article not found (ID: ${articleId}). It may have been deleted or the ID is incorrect. Check Firestore 'articles' collection or ensure the article exists.`);
    }
  } catch (error) {
    console.error('Error loading article (ID:', articleId, '):', error.message, error.code);
    let errorMessage = `Failed to load article (ID: ${articleId}): ${error.message}. `;
    if (error.code === 'permission-denied') {
      errorMessage += 'Check Firestore security rules to ensure public read access to the "articles" collection.';
    } else if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
      errorMessage += 'Network issue detected. Check your internet connection and try again.';
    } else {
      errorMessage += 'Check Firestore for the article or try refreshing the page.';
    }
    displayErrorMessage('#article-content', errorMessage);
  }
}

// Load comments
async function loadComments(articleId) {
  const commentList = document.getElementById('comment-list');
  if (!db || !commentList) return;
  const q = query(collection(db, 'articles', articleId, 'comments'), orderBy('timestamp', 'desc'));
  try {
    const snapshot = await withRetry(() => getDocs(q));
    commentList.innerHTML = '';
    if (snapshot.empty) {
      commentList.innerHTML = '<p>No comments yet.</p>';
      return;
    }
    snapshot.forEach(doc => {
      const comment = doc.data();
      const commentElement = document.createElement('div');
      commentElement.classList.add('comment');
      commentElement.innerHTML = `
        <p><strong>Anonymous</strong> on ${formatTimestamp(comment.timestamp)}</p>
        <p>${comment.text}</p>
        <button class="reply-button" data-comment-id="${doc.id}" aria-label="Reply to comment">Reply</button>
        <div class="reply-list" data-comment-id="${doc.id}"></div>
      `;
      commentList.appendChild(commentElement);
      loadReplies(articleId, doc.id);
    });
    document.querySelectorAll('.reply-button').forEach(button => {
      button.addEventListener('click', () => {
        const commentId = button.dataset.commentId;
        const replyForm = document.createElement('form');
        replyForm.classList.add('reply-form');
        replyForm.innerHTML = `
          <textarea class="reply-input" placeholder="Write a reply..." required></textarea>
          <button type="submit" class="reply-submit">Post Reply</button>
        `;
        button.after(replyForm);
        replyForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const replyInput = replyForm.querySelector('.reply-input');
          if (replyInput.value) {
            try {
              await withRetry(() => addDoc(collection(db, 'articles', articleId, 'comments', commentId, 'replies'), {
                text: replyInput.value,
                timestamp: serverTimestamp()
              }));
              replyForm.remove();
              loadReplies(articleId, commentId);
            } catch (error) {
              console.error('Error adding reply:', error.message);
              displayErrorMessage(`.reply-list[data-comment-id="${commentId}"]`, 'Failed to post reply. Please try again.');
            }
          }
        });
      });
    });
  } catch (error) {
    console.error('Error loading comments:', error.message);
    displayErrorMessage('#comment-list', 'Failed to load comments. Please try again.');
  }
}

// Load replies
async function loadReplies(articleId, commentId) {
  const replyList = document.querySelector(`.reply-list[data-comment-id="${commentId}"]`);
  if (!db || !replyList) return;
  const q = query(collection(db, 'articles', articleId, 'comments', commentId, 'replies'), orderBy('timestamp', 'desc'));
  try {
    const snapshot = await withRetry(() => getDocs(q));
    replyList.innerHTML = '';
    snapshot.forEach(doc => {
      const reply = doc.data();
      const replyElement = document.createElement('div');
      replyElement.classList.add('reply');
      replyElement.innerHTML = `
        <p><strong>Anonymous</strong> on ${formatTimestamp(reply.timestamp)}</p>
        <p>${reply.text}</p>
      `;
      replyList.appendChild(replyElement);
    });
  } catch (error) {
    console.error('Error loading replies:', error.message);
    displayErrorMessage(`.reply-list[data-comment-id="${commentId}"]`, 'Failed to load replies. Please try again.');
  }
}

// Load search results
async function loadSearchResults() {
  const urlParams = new URLSearchParams(window.location.search);
  const searchQuery = urlParams.get('q')?.toLowerCase();
  const searchResults = document.getElementById('search-results');
  const searchTitle = document.getElementById('search-title');
  if (!db || !searchQuery || !searchResults || !searchTitle) return;

  searchTitle.textContent = `Search Results for "${searchQuery}"`;
  document.title = `Naija Truths - Search: ${searchQuery}`;
  searchResults.innerHTML = '<p>Loading results...</p>';

  try {
    const q = query(
      collection(db, 'articles'),
      where('title_lowercase', '>=', searchQuery),
      where('title_lowercase', '<=', searchQuery + '\uf8ff'),
      orderBy('title_lowercase'),
      limit(10)
    );
    const snapshot = await withRetry(() => getDocs(q));
    searchResults.innerHTML = '';
    if (snapshot.empty) {
      searchResults.innerHTML = '<p>No results found.</p>';
      return;
    }
    snapshot.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('div');
      articleElement.classList.add('news-card');
      articleElement.innerHTML = `
        <a href="article.html?id=${doc.id}" class="article-link">
          <img src="${article.image && isValidUrl(article.image) ? article.image : 'https://via.placeholder.com/400x200'}" 
               srcset="${article.image && isValidUrl(article.image) ? `${article.image} 400w, ${article.image} 200w` : 'https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w'}" 
               sizes="(max-width: 767px) 200px, 400px" 
               alt="${article.title || 'Article Image'}" 
               loading="lazy"
               onerror="this.src='https://via.placeholder.com/400x200'; this.srcset='https://via.placeholder.com/400x200 400w, https://via.placeholder.com/200x100 200w'; this.sizes='(max-width: 767px) 200px, 400px';">
          <h3>${article.title || 'Untitled Article'}</h3>
          <p class="article-writer premium-writer">By ${article.writer || 'Anonymous'}</p>
          <p>${article.summary || (article.content ? article.content.substring(0, 100) + '...' : 'No summary available')}</p>
          <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
          ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
          ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        </a>
      `;
      searchResults.appendChild(articleElement);
    });
  } catch (error) {
    console.error('Error loading search results:', error.message);
    displayErrorMessage('#search-results', 'Failed to load search results. Please try again.');
  }
}

// Admin login
const loginForm = document.getElementById('admin-login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    try {
      const userCredential = await withRetry(() => signInWithEmailAndPassword(auth, email, password));
      const user = userCredential.user;
      const idTokenResult = await user.getIdTokenResult();
      if (idTokenResult.claims.admin) {
        window.location.href = 'admin.html';
      } else {
        displayErrorMessage('#admin-login-form', 'You do not have admin privileges.');
        await signOut(auth);
      }
    } catch (error) {
      console.error('Login error:', error.message);
      displayErrorMessage('#admin-login-form', 'Login failed: Invalid credentials or network issue.');
    }
  });
}

// Logout
const logoutButton = document.getElementById('logout-button');
if (logoutButton) {
  logoutButton.addEventListener('click', () => {
    signOut(auth).then(() => {
      window.location.href = 'index.html';
    }).catch(error => {
      console.error('Logout error:', error.message);
      displayErrorMessage('#admin-content', 'Failed to log out. Please try again.');
    });
  });
}

// Article form submission
const articleForm = document.getElementById('article-form');
if (articleForm) {
  articleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!db || !auth.currentUser) {
      displayErrorMessage('#article-form', 'Not logged in or database not initialized.');
      return;
    }
    const id = document.getElementById('article-id').value;
    const title = document.getElementById('article-title-input').value;
    const writer = document.getElementById('article-writer-input').value.trim();
    const summary = document.getElementById('article-summary-input').value;
    const content = quill ? quill.root.innerHTML : document.getElementById('article-content-input')?.value || '';
    const imageUrl = document.getElementById('article-image-input').value;
    const videoUrl = document.getElementById('article-video-input').value;
    const category = document.getElementById('article-category-input').value;
    const breakingNews = document.getElementById('article-breaking-news-input').checked;
    const verified = document.getElementById('article-verified-input').checked;

    if (!title || title.length < 5) {
      displayErrorMessage('#article-form', 'Title must be at least 5 characters.');
      return;
    }
    if (!content || content.length < 20) {
      displayErrorMessage('#article-form', 'Content must be at least 20 characters.');
      return;
    }
    if (!category) {
      displayErrorMessage('#article-form', 'Category is required.');
      return;
    }
    if (imageUrl && !isValidUrl(imageUrl)) {
      displayErrorMessage('#article-form', 'Image URL is invalid.');
      return;
    }
    if (videoUrl && !isValidUrl(videoUrl)) {
      displayErrorMessage('#article-form', 'Video URL is invalid.');
      return;
    }

    const article = {
      title,
      title_lowercase: title.toLowerCase(),
      writer: writer || '',
      summary,
      content,
      image: imageUrl || '',
      video: videoUrl || '',
      category,
      breakingNews: !!breakingNews,
      verified: !!verified,
      createdAt: serverTimestamp(),
      likes: 0,
      views: 0
    };

    console.log('Submitting article:', article);

    try {
      if (id) {
        await withRetry(() => updateDoc(doc(db, 'articles', id), article));
        alert('Article updated successfully!');
      } else {
        await withRetry(() => addDoc(collection(db, 'articles'), article));
        alert('Article published successfully!');
      }
      articleForm.reset();
      if (quill) quill.setContents([]);
      document.getElementById('article-id').value = '';
      document.getElementById('preview-section').style.display = 'none';
      loadAdminArticles();
    } catch (error) {
      console.error('Error publishing article:', error.message);
      displayErrorMessage('#article-form', 'Failed to publish article: ' + error.message);
    }
  });
}

// Preview article
const previewButton = document.getElementById('preview-button');
if (previewButton) {
  previewButton.addEventListener('click', () => {
    const title = document.getElementById('article-title-input').value;
    const writer = document.getElementById('article-writer-input').value.trim();
    const summary = document.getElementById('article-summary-input').value;
    const content = quill ? quill.root.innerHTML : document.getElementById('article-content-input')?.value || '';
    const image = document.getElementById('article-image-input').value;
    const video = document.getElementById('article-video-input').value;
    const category = document.getElementById('article-category-input').value;
    const breakingNews = document.getElementById('article-breaking-news-input').checked;
    const verified = document.getElementById('article-verified-input').checked;

    if (!title || title.length < 5) {
      displayErrorMessage('#article-form', 'Title must be at least 5 characters.');
      return;
    }
    if (!content || content.length < 20) {
      displayErrorMessage('#article-form', 'Content must be at least 20 characters.');
      return;
    }
    if (!category) {
      displayErrorMessage('#article-form', 'Category is required.');
      return;
    }
    if (image && !isValidUrl(image)) {
      displayErrorMessage('#article-form', 'Image URL is invalid.');
      return;
    }
    if (video && !isValidUrl(video)) {
      displayErrorMessage('#article-form', 'Video URL is invalid.');
      return;
    }

    document.getElementById('preview-title').textContent = title;
    document.getElementById('preview-writer').textContent = `By ${writer || 'Anonymous'}`;
    document.getElementById('preview-writer').classList.add('premium-writer');
    document.getElementById('preview-summary').textContent = summary;
    document.getElementById('preview-content').innerHTML = content;
    document.getElementById('preview-category').textContent = category.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    document.getElementById('preview-breaking-news').style.display = breakingNews ? 'block' : 'none';
    document.getElementById('preview-verified').style.display = verified ? 'block' : 'none';
    const previewImage = document.getElementById('preview-image');
    if (image && isValidUrl(image)) {
      previewImage.src = image;
      previewImage.srcset = `${image} 1200w, ${image} 768w, ${image} 480w`;
      previewImage.sizes = '(max-width: 480px) 100vw, (max-width: 768px) 80vw, 800px';
      previewImage.style.display = 'block';
    } else {
      previewImage.style.display = 'none';
    }
    const previewVideo = document.getElementById('preview-video');
    if (video && isValidUrl(video)) {
      previewVideo.src = video;
      previewVideo.style.display = 'block';
    } else {
      previewVideo.style.display = 'none';
    }
    document.getElementById('preview-section').style.display = 'block';
    document.getElementById('preview-date').textContent = `Posted: ${new Date().toLocaleDateString()}`;
  });
}

// Clear article form
const clearButton = document.getElementById('clear-button');
if (clearButton) {
  clearButton.addEventListener('click', () => {
    articleForm.reset();
    if (quill) quill.setContents([]);
    document.getElementById('article-id').value = '';
    document.getElementById('preview-section').style.display = 'none';
  });
}

// Delete article
async function deleteArticle(articleId) {
  if (!db || !auth.currentUser) {
    displayErrorMessage('#article-list', 'Not logged in or database not initialized.');
    return;
  }
  if (confirm('Are you sure you want to delete this article? This action cannot be undone.')) {
    try {
      await withRetry(() => deleteDoc(doc(db, 'articles', articleId)));
      alert('Article deleted successfully!');
      loadAdminArticles();
    } catch (error) {
      console.error('Error deleting article:', error.message);
      displayErrorMessage('#article-list', 'Failed to delete article: ' + error.message);
    }
  }
}

// Load admin articles
async function loadAdminArticles() {
  const articleList = document.getElementById('article-list');
  if (!db || !articleList) return;
  try {
    const snapshot = await withRetry(() => getDocs(query(collection(db, 'articles'), orderBy('createdAt', 'desc'))));
    articleList.innerHTML = '';
    if (snapshot.empty) {
      articleList.innerHTML = '<p>No articles found.</p>';
      return;
    }
    snapshot.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('div');
      articleElement.classList.add('news-card');
      articleElement.innerHTML = `
        <h3>${article.title || 'Untitled Article'}</h3>
        <p class="article-writer">By ${article.writer || 'Anonymous'}</p>
        <p>${article.summary || 'No summary available'}</p>
        <p>${article.category.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}</p>
        <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
        ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
        ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        <button class="edit-button" data-id="${doc.id}">Edit</button>
        <button class="delete-button" data-id="${doc.id}">Delete</button>
      `;
      articleList.appendChild(articleElement);
    });
    document.querySelectorAll('.edit-button').forEach(button => {
      button.addEventListener('click', async () => {
        const articleId = button.dataset.id;
        const docRef = doc(db, 'articles', articleId);
        try {
          const docSnap = await withRetry(() => getDoc(docRef));
          const article = docSnap.data();
          document.getElementById('article-id').value = articleId;
          document.getElementById('article-title-input').value = article.title || '';
          document.getElementById('article-writer-input').value = article.writer || '';
          document.getElementById('article-summary-input').value = article.summary || '';
          if (quill) {
            quill.root.innerHTML = article.content || '';
          } else {
            document.getElementById('article-content-input').value = article.content || '';
          }
          document.getElementById('article-image-input').value = article.image || '';
          document.getElementById('article-video-input').value = article.video || '';
          document.getElementById('article-category-input').value = article.category || '';
          document.getElementById('article-breaking-news-input').checked = !!article.breakingNews;
          document.getElementById('article-verified-input').checked = !!article.verified;
        } catch (error) {
          console.error('Error loading article for editing:', error.message);
          displayErrorMessage('#article-list', 'Failed to load article for editing. Please try again.');
        }
      });
    });
    document.querySelectorAll('.delete-button').forEach(button => {
      button.addEventListener('click', () => {
        const articleId = button.dataset.id;
        deleteArticle(articleId);
      });
    });
  } catch (error) {
    console.error('Error loading admin articles:', error.message);
    displayErrorMessage('#article-list', 'Failed to load articles. Please try again.');
  }
}

// Search admin articles
async function searchAdminArticles() {
  const searchInput = document.getElementById('article-search-input').value.trim();
  const articleList = document.getElementById('article-list');
  if (!db || !articleList) {
    displayErrorMessage('#article-list', 'Database or article list not initialized. Please refresh the page.');
    return;
  }

  articleList.innerHTML = '<p>Loading articles...</p>';

  try {
    let snapshot;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    
    if (!searchInput) {
      const q = query(collection(db, 'articles'), orderBy('createdAt', 'desc'), limit(50));
      snapshot = await withRetry(() => getDocs(q));
    } else if (datePattern.test(searchInput)) {
      const startDate = new Date(searchInput + 'T00:00:00Z');
      if (isNaN(startDate.getTime())) {
        articleList.innerHTML = '';
        displayErrorMessage('#article-list', 'Invalid date format. Please use YYYY-MM-DD (e.g., 2025-09-18).');
        return;
      }
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
      const q = query(
        collection(db, 'articles'),
        where('createdAt', '>=', startDate),
        where('createdAt', '<', endDate),
        orderBy('createdAt', 'desc'),
        limit(50)
      );
      snapshot = await withRetry(() => getDocs(q));
    } else {
      const titleQuery = query(
        collection(db, 'articles'),
        where('title_lowercase', '>=', searchInput.toLowerCase()),
        where('title_lowercase', '<=', searchInput.toLowerCase() + '\uf8ff'),
        orderBy('title_lowercase'),
        orderBy('createdAt', 'desc'),
        limit(50)
      );
      const writerQuery = query(
        collection(db, 'articles'),
        where('writer', '>=', searchInput),
        where('writer', '<=', searchInput + '\uf8ff'),
        orderBy('writer'),
        orderBy('createdAt', 'desc'),
        limit(50)
      );
      
      const [titleSnapshot, writerSnapshot] = await Promise.all([
        withRetry(() => getDocs(titleQuery)),
        withRetry(() => getDocs(writerQuery))
      ]);
      
      const articles = new Map();
      titleSnapshot.forEach(doc => articles.set(doc.id, doc));
      writerSnapshot.forEach(doc => articles.set(doc.id, doc));
      snapshot = {
        docs: Array.from(articles.values()),
        empty: articles.size === 0
      };
    }

    articleList.innerHTML = '';
    if (snapshot.empty) {
      articleList.innerHTML = '<p>No articles found for the given search.</p>';
      return;
    }

    snapshot.docs.forEach(doc => {
      const article = doc.data();
      const articleElement = document.createElement('div');
      articleElement.classList.add('news-card');
      articleElement.innerHTML = `
        <h3>${article.title || 'Untitled Article'}</h3>
        <p class="article-writer">By ${article.writer || 'Anonymous'}</p>
        <p>${article.summary || 'No summary available'}</p>
        <p>${article.category.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}</p>
        <p class="article-time">Posted: ${formatTimestamp(article.createdAt)}</p>
        ${article.breakingNews ? '<span class="breaking-news-badge">Breaking News</span>' : ''}
        ${article.verified ? '<span class="verified-badge">Verified</span>' : ''}
        <button class="edit-button" data-id="${doc.id}">Edit</button>
        <button class="delete-button" data-id="${doc.id}">Delete</button>
      `;
      articleList.appendChild(articleElement);
    });

    document.querySelectorAll('.edit-button').forEach(button => {
      button.addEventListener('click', async () => {
        const articleId = button.dataset.id;
        const docRef = doc(db, 'articles', articleId);
        try {
          const docSnap = await withRetry(() => getDoc(docRef));
          const article = docSnap.data();
          document.getElementById('article-id').value = articleId;
          document.getElementById('article-title-input').value = article.title || '';
          document.getElementById('article-writer-input').value = article.writer || '';
          document.getElementById('article-summary-input').value = article.summary || '';
          if (quill) {
            quill.root.innerHTML = article.content || '';
          } else {
            document.getElementById('article-content-input').value = article.content || '';
          }
          document.getElementById('article-image-input').value = article.image || '';
          document.getElementById('article-video-input').value = article.video || '';
          document.getElementById('article-category-input').value = article.category || '';
          document.getElementById('article-breaking-news-input').checked = !!article.breakingNews;
          document.getElementById('article-verified-input').checked = !!article.verified;
        } catch (error) {
          console.error('Error loading article for editing:', error.message);
          displayErrorMessage('#article-list', 'Failed to load article for editing. Please try again.');
        }
      });
    });
    document.querySelectorAll('.delete-button').forEach(button => {
      button.addEventListener('click', () => {
        const articleId = button.dataset.id;
        deleteArticle(articleId);
      });
    });
  } catch (error) {
    console.error('Error searching admin articles:', error.message, error.code);
    let errorMessage = 'Failed to load articles: ' + error.message + '. ';
    if (error.code === 'permission-denied') {
      errorMessage += 'Check Firestore security rules to ensure admin read access to the "articles" collection.';
    } else if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
      errorMessage += 'Network issue detected. Check your internet connection and try again.';
    } else if (error.code === 'invalid-argument') {
      errorMessage += 'Invalid search query. Ensure the date is in YYYY-MM-DD format or check the title/writer input.';
    } else {
      errorMessage += 'Please verify the search query or try refreshing the page.';
    }
    articleList.innerHTML = '';
    displayErrorMessage('#article-list', errorMessage);
  }
}

// Like button
document.querySelectorAll('.like-button').forEach(button => {
  button.addEventListener('click', async () => {
    if (!auth.currentUser) {
      displayErrorMessage('.article-card', 'Please log in to like articles.');
      return;
    }
    const likeCountSpan = button.querySelector('#like-count');
    let count = parseInt(likeCountSpan.textContent) || 0;
    likeCountSpan.textContent = count + 1;
    button.classList.add('liked');
    button.disabled = true;
    const articleId = button.closest('.article-card')?.dataset.id;
    if (db && articleId) {
      try {
        await withRetry(() => updateDoc(doc(db, 'articles', articleId), { likes: increment(1) }));
      } catch (error) {
        console.error('Error updating likes:', error.message);
        displayErrorMessage('.article-card', 'Failed to update likes. Please try again.');
        likeCountSpan.textContent = count;
        button.classList.remove('liked');
        button.disabled = false;
      }
    }
  });
});

// Comment submission
document.querySelectorAll('.comment-submit').forEach(button => {
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!auth.currentUser) {
      displayErrorMessage('#comment-list', 'Please log in to comment.');
      return;
    }
    const commentInput = document.getElementById('comment-input');
    if (commentInput?.value) {
      const articleId = document.querySelector('.article-card')?.dataset.id;
      if (db && articleId) {
        try {
          await withRetry(() => addDoc(collection(db, 'articles', articleId, 'comments'), {
            text: commentInput.value,
            timestamp: serverTimestamp(),
            userId: auth.currentUser.uid
          }));
          commentInput.value = '';
          loadComments(articleId);
        } catch (error) {
          console.error('Error adding comment:', error.message);
          displayErrorMessage('#comment-list', 'Failed to post comment. Please try again.');
        }
      }
    }
  });
});

// Save article
document.querySelectorAll('.save-button').forEach(button => {
  button.addEventListener('click', async () => {
    if (!auth.currentUser) {
      displayErrorMessage('.article-card', 'Please log in to save articles.');
      return;
    }
    const articleId = button.closest('.article-card')?.dataset.id;
    if (db && articleId) {
      try {
        await withRetry(() => addDoc(collection(db, 'users', auth.currentUser.uid, 'savedArticles'), {
          articleId,
          savedAt: serverTimestamp()
        }));
        button.classList.add('saved');
        button.textContent = 'Saved';
        button.disabled = true;
      } catch (error) {
        console.error('Error saving article:', error.message);
        displayErrorMessage('.article-card', 'Failed to save article. Please try again.');
      }
    }
  });
});

// Share buttons
document.querySelectorAll('.share-button').forEach(button => {
  button.addEventListener('click', () => {
    const platform = button.dataset.platform;
    const url = window.location.href;
    const title = document.getElementById('article-title')?.textContent || 'Naija Truths Article';
    let shareUrl;
    switch (platform) {
      case 'facebook':
        shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
        break;
      case 'x':
        shareUrl = `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`;
        break;
      case 'whatsapp':
        shareUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(title + ' ' + url)}`;
        break;
    }
    window.open(shareUrl, '_blank');
  });
});

// Load more buttons
const loadMoreLatestButton = document.querySelector('.latest-news .load-more-button');
if (loadMoreLatestButton) {
  loadMoreLatestButton.addEventListener('click', async () => {
    loadMoreLatestButton.disabled = true;
    loadMoreLatestButton.textContent = 'Loading...';
    const categoryFilter = document.getElementById('category-filter');
    const selectedCategory = categoryFilter ? categoryFilter.value : '';
    await fetchLatestNewsArticles(false, loadMoreLatestButton, selectedCategory);
    loadMoreLatestButton.disabled = false;
    loadMoreLatestButton.textContent = 'Load More';
  });
}

const loadMoreCategoryButton = document.querySelector('.category-section .load-more-button');
if (loadMoreCategoryButton) {
  loadMoreCategoryButton.addEventListener('click', async () => {
    loadMoreCategoryButton.disabled = true;
    loadMoreCategoryButton.textContent = 'Loading...';
    const urlParams = new URLSearchParams(window.location.search);
    const category = urlParams.get('cat');
    if (category) {
      await fetchCategoryArticles(category, false);
    }
    loadMoreCategoryButton.disabled = false;
    loadMoreCategoryButton.textContent = 'Load More';
  });
}

// Category filter for latest news
const categoryFilter = document.getElementById('category-filter');
if (categoryFilter) {
  categoryFilter.addEventListener('change', async () => {
    const selectedCategory = categoryFilter.value;
    console.log('Category filter changed to:', selectedCategory);
    await loadLatestNewsArticles(selectedCategory);
  });
}

// Mobile navigation with yellow highlight
const hamburger = document.querySelector('.hamburger');
const mobileNav = document.querySelector('.mobile-nav');
if (hamburger && mobileNav) {
  hamburger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = hamburger.classList.toggle('active');
    mobileNav.classList.toggle('active');
    hamburger.classList.toggle('highlight', isOpen);
    hamburger.setAttribute('aria-expanded', isOpen);
    if (isOpen) {
      mobileNav.focus();
      trapFocus(mobileNav);
    }
  });

  document.addEventListener('click', (e) => {
    if (mobileNav.classList.contains('active') && !mobileNav.contains(e.target) && !hamburger.contains(e.target)) {
      hamburger.classList.remove('active', 'highlight');
      mobileNav.classList.remove('active');
      hamburger.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mobileNav.classList.contains('active')) {
      hamburger.classList.remove('active', 'highlight');
      mobileNav.classList.remove('active');
      hamburger.setAttribute('aria-expanded', 'false');
    }
  });

  document.querySelectorAll('.mobile-nav a').forEach(link => {
    link.addEventListener('click', () => {
      hamburger.classList.remove('active', 'highlight');
      mobileNav.classList.remove('active');
      hamburger.setAttribute('aria-expanded', 'false');
    });
  });
}

function trapFocus(element) {
  const focusableElements = element.querySelectorAll('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])');
  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];

  element.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      if (e.shiftKey && document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable.focus();
      } else if (!e.shiftKey && document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable.focus();
      }
    }
  });
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href*="#"]').forEach(anchor => {
  anchor.addEventListener('click', (e) => {
    const href = anchor.getAttribute('href');
    if (href.startsWith('#')) {
      e.preventDefault();
      const targetId = href.substring(1);
      const targetElement = document.getElementById(targetId);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth' });
      }
    }
  });
});

// Parallax effect
window.addEventListener('scroll', () => {
  const parallax = document.querySelector('.parallax-bg');
  if (parallax) {
    const scrollPosition = document.documentElement.scrollTop || document.body.scrollTop;
    parallax.style.transform = `translateY(${scrollPosition * 0.5}px)`;
  }
});

// Scroll-to-top button
const scrollToTopWrapper = document.querySelector('.scroll-to-top-wrapper');
const scrollToTopButton = document.querySelector('.scroll-to-top');

if (scrollToTopWrapper && scrollToTopButton) {
  // Update button visibility
  function updateScrollButtonVisibility() {
    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
    if (scrollTop > 100) {
      scrollToTopWrapper.classList.remove('hidden');
      scrollToTopWrapper.classList.add('visible');
    } else {
      scrollToTopWrapper.classList.remove('visible');
      scrollToTopWrapper.classList.add('hidden');
    }
  }

  // Scroll event listener
  window.addEventListener('scroll', updateScrollButtonVisibility);

  // Initialize button attributes for accessibility
  scrollToTopButton.setAttribute('tabindex', '0');
  scrollToTopButton.setAttribute('role', 'button');
  scrollToTopButton.setAttribute('aria-label', 'Scroll to top');

  // Click event for scroll-to-top
  scrollToTopButton.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Keyboard event for accessibility
  scrollToTopButton.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  // Initial update
  updateScrollButtonVisibility();
} else {
  console.warn('Scroll-to-top wrapper or button not found in DOM.');
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initializeFirebase().then(() => {
    if (document.getElementById('admin-login-section')) {
      onAuthStateChanged(auth, (user) => {
        if (user) {
          user.getIdTokenResult().then((idTokenResult) => {
            if (idTokenResult.claims.admin) {
              window.location.href = 'admin.html';
            }
          }).catch(error => {
            console.error('Error checking admin status:', error.message);
            displayErrorMessage('#admin-login-section', 'Failed to verify admin status. Please try again.');
          });
        }
      });
    } else if (document.getElementById('admin-content')) {
      onAuthStateChanged(auth, (user) => {
        if (user) {
          user.getIdTokenResult().then((idTokenResult) => {
            if (idTokenResult.claims.admin) {
              document.getElementById('admin-content').style.display = 'block';
              document.getElementById('logout-button').style.display = 'inline-block';
              loadAdminArticles();
              const searchButton = document.getElementById('article-search-button');
              const clearButton = document.getElementById('article-search-clear');
              if (searchButton) {
                searchButton.addEventListener('click', () => {
                  searchAdminArticles();
                });
              }
              if (clearButton) {
                clearButton.addEventListener('click', () => {
                  document.getElementById('article-search-input').value = '';
                  loadAdminArticles();
                });
              }
            } else {
              window.location.href = 'index.html';
            }
          }).catch(error => {
            console.error('Error checking admin status:', error.message);
            displayErrorMessage('#admin-content', 'Failed to verify admin status. Please try again.');
            window.location.href = 'index.html';
          });
        } else {
          window.location.href = 'index.html';
        }
      });
    } else {
      if (document.querySelector('.article-card')) {
        loadArticle();
      }
      if (document.getElementById('category-articles')) {
        loadCategoryArticles();
      }
      if (document.getElementById('politics-articles')) {
        loadPoliticsArticles();
      }
      if (document.getElementById('latest-news-articles')) {
        loadLatestNewsArticles();
      }
      if (document.getElementById('search-results')) {
        loadSearchResults();
      }
      loadArticles();
    }
    const preloader = document.getElementById('preloader');
    if (preloader) {
      preloader.style.opacity = '0';
      setTimeout(() => {
        preloader.style.display = 'none';
      }, 300);
    }
  }).catch(error => {
    console.error('DOM content load error:', error.message);
    displayErrorMessage('body', 'Failed to initialize the page. Please refresh.');
  });
});

// Fallback for preloader
setTimeout(() => {
  const preloader = document.getElementById('preloader');
  if (preloader && preloader.style.display !== 'none') {
    preloader.style.opacity = '0';
    preloader.style.display = 'none';
  }
}, 2000);