import utils from '@percy/sdk-utils';
import GenericProvider from './genericProvider.js';
import Cache from '../util/cache.js';
import Tile from '../util/tile.js';
import NormalizeData from '../metadata/normalizeData.js';
import TimeIt from '../util/timing.js';

const log = utils.logger('webdriver-utils:automateProvider');

export default class AutomateProvider extends GenericProvider {
  constructor(
    sessionId,
    commandExecutorUrl,
    capabilities,
    sessionCapabilites,
    clientInfo,
    environmentInfo,
    options,
    buildInfo
  ) {
    super(
      sessionId,
      commandExecutorUrl,
      capabilities,
      sessionCapabilites,
      clientInfo,
      environmentInfo,
      options,
      buildInfo
    );
    this._markedPercy = false;
    this.automateResults = null;
  }

  static supports(commandExecutorUrl) {
    return commandExecutorUrl.includes(process.env.AA_DOMAIN || 'browserstack');
  }

  async screenshot(name, {
    ignoreRegionXpaths = [],
    ignoreRegionSelectors = [],
    ignoreRegionElements = [],
    customIgnoreRegions = [],
    considerRegionXpaths = [],
    considerRegionSelectors = [],
    considerRegionElements = [],
    customConsiderRegions = []
  }) {
    let response = null;
    let error;
    log.debug(`[${name}] : Preparing to capture screenshots on automate ...`);
    try {
      log.debug(`[${name}] : Marking automate session as percy ...`);
      const result = await this.percyScreenshotBegin(name);
      this.automateResults = JSON.parse(result.value);
      log.debug(`[${name}] : Fetching the debug url ...`);
      this.setDebugUrl();
      response = await super.screenshot(name, {
        ignoreRegionXpaths,
        ignoreRegionSelectors,
        ignoreRegionElements,
        customIgnoreRegions,
        considerRegionXpaths,
        considerRegionSelectors,
        considerRegionElements,
        customConsiderRegions
      });
    } catch (e) {
      error = e;
      throw e;
    } finally {
      await this.percyScreenshotEnd(name, error);
    }
    return response;
  }

  async percyScreenshotBegin(name) {
    return await TimeIt.run('percyScreenshotBegin', async () => {
      try {
        let result = await this.browserstackExecutor('percyScreenshot', {
          name,
          percyBuildId: this.buildInfo.id,
          percyBuildUrl: this.buildInfo.url,
          state: 'begin'
        });
        this._markedPercy = result.success;
        return result;
      } catch (e) {
        log.debug(`[${name}] : Could not mark Automate session as percy`);
        log.error(`[${name}] : error: ${e.toString()}`);
        return null;
      }
    });
  }

  async percyScreenshotEnd(name, error) {
    return await TimeIt.run('percyScreenshotEnd', async () => {
      try {
        await this.browserstackExecutor('percyScreenshot', {
          name,
          percyScreenshotUrl: this.buildInfo?.url,
          status: error ? 'failure' : 'success',
          statusMessage: error ? `${error}` : '',
          state: 'end'
        });
      } catch (e) {
        log.debug(`[${name}] : Could not execute percyScreenshot command for Automate`);
        log.error(e);
      }
    });
  }

  async getTiles(headerHeight, footerHeight, fullscreen) {
    if (!this.driver) throw new Error('Driver is null, please initialize driver with createDriver().');
    log.debug('Starting actual screenshotting phase');
    const dpr = await this.metaData.devicePixelRatio();
    const response = await TimeIt.run('percyScreenshot:screenshot', async () => {
      return await this.browserstackExecutor('percyScreenshot', {
        state: 'screenshot',
        percyBuildId: this.buildInfo.id,
        screenshotType: 'singlepage',
        scaleFactor: dpr,
        options: this.options
      });
    });

    const responseValue = JSON.parse(response.value);
    if (!responseValue.success) {
      throw new Error('Failed to get screenshots from Automate.' +
      ' Check dashboard for error.');
    }

    const tiles = [];
    const tileResponse = JSON.parse(responseValue.result);
    log.debug('Tiles captured successfully');
    const windowHeight = responseValue?.metadata?.window_height || 0;
    for (let tileData of tileResponse.sha) {
      tiles.push(new Tile({
        statusBarHeight: tileResponse.header_height || 0,
        navBarHeight: tileResponse.footer_height || 0,
        headerHeight,
        footerHeight,
        fullscreen,
        sha: tileData.split('-')[0] // drop build id
      }));
    }

    const metadata = {
      windowHeight: Math.ceil(windowHeight * dpr)
    };
    return { tiles: tiles, domInfoSha: tileResponse.dom_sha, metadata: metadata };
  }

  async browserstackExecutor(action, args) {
    if (!this.driver) throw new Error('Driver is null, please initialize driver with createDriver().');
    let options = args ? { action, arguments: args } : { action };
    let res = await this.driver.executeScript({ script: `browserstack_executor: ${JSON.stringify(options)}`, args: [] });
    return res;
  }

  async setDebugUrl() {
    if (!this.driver) throw new Error('Driver is null, please initialize driver with createDriver().');
    this.debugUrl = await Cache.withCache(Cache.bstackSessionDetails, this.driver.sessionId,
      async () => {
        return `https://automate.browserstack.com/builds/${this.automateResults.buildHash}/sessions/${this.automateResults.sessionHash}`;
      });
  }

  async getTag() {
    if (!this.driver) throw new Error('Driver is null, please initialize driver with createDriver().');
    if (!this.automateResults) throw new Error('Comparison tag details not available');

    const automateCaps = this.automateResults.capabilities;
    const normalizeTags = new NormalizeData();

    let deviceName = this.automateResults.deviceName;
    const osName = normalizeTags.osRollUp(automateCaps.os);
    const osVersion = automateCaps.os_version?.split('.')[0];
    const browserName = normalizeTags.browserRollUp(automateCaps.browserName, this.metaData.device());
    const browserVersion = normalizeTags.browserVersionOrDeviceNameRollup(automateCaps.browserVersion, deviceName, this.metaData.device());

    if (!this.metaData.device()) {
      deviceName = `${osName}_${osVersion}_${browserName}_${browserVersion}`;
    }

    let { width, height } = await this.metaData.windowSize();
    const resolution = await this.metaData.screenResolution();
    const orientation = (this.metaData.orientation() || automateCaps.deviceOrientation)?.toLowerCase();

    return {
      name: deviceName,
      osName,
      osVersion,
      width,
      height,
      orientation,
      browserName,
      browserVersion,
      resolution
    };
  }
}
