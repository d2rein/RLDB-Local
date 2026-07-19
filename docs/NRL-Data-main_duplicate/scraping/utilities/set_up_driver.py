"""
Module to set up Chrome Web Driver for Scalping.

This module provides a function to set up the Chrome Web Driver with specific options
for automated web scraping tasks related to Scalping.
"""

import chromedriver_autoinstaller
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
import os


def set_up_driver():
    """Set up the Chrome Web Driver for Scalping.

    This function sets up the Chrome Web Driver with specified options.
    
    :return: WebDriver object for Chrome
    """
    options = Options()
    # Ignore annoying messages from the NRL website 
    options.add_argument('--ignore-certificate-errors')
    
    # Run Selenium in headless mode
    options.add_argument('--headless')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('log-level=3')
    
    # Exclude logging to assist with errors caused by NRL website 
    options.add_experimental_option('excludeSwitches', ['enable-logging'])

    chrome_bin = os.environ.get("CHROME_BIN")
    if chrome_bin:
        options.binary_location = chrome_bin
    
    try:
        return webdriver.Chrome(options=options)
    except Exception:
        driver_path = chromedriver_autoinstaller.install()
        return webdriver.Chrome(service=Service(driver_path), options=options)
