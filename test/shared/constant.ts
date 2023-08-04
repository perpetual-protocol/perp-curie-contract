import { BigNumber } from "ethers"

export const CACHED_TWAP_INTERVAL = 15 * 60
export const USDC_DECIMALS = 6
export const WBTC_DECIMALS = 8
export const WETH_DECIMALS = 18
export const PRICEFEED_DISPATCHER_DECIMALS = 18
export const CHAINLINK_AGGREGATOR_DECIMALS = 8

// There might be dust position or open notional after reducing position or removing liquidity.
// Ignore the dust position or notional in tests, the value is according to the experience.
// IGNORABLE_DUST represents the dust in wei.
export const IGNORABLE_DUST = 500

export const DECIMAL_PLACES_18 = BigNumber.from((10 ** 18).toString())
