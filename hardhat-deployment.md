# Contract deployment order

### Boilerplate contracts

1. Deploy 2 virtual tokens -> BaseToken.sol & QuoteToken.sol
2. Deploy ERC20 Token `const USDC = (await tokenFactory.deploy()) as TestERC20``
3. Deploy UniswapV3Factory then create a pool 
4. `await uniV3Factory.createPool(baseToken.address, quoteToken.address, uniFeeTier)`` /* uniFeeTier = 10000, // 1% */


### Protocol contracts

1. ClearingHouseConfig -> no arguments
2. MarketRegistry -> uniV3Factory.address & quoteToken.address
   2.1. For each market, we deploy a pair of two virtual tokens (with no real value) and initiate a new Uniswap V3 pool to provide liquidity to.
      2.1.1. Base token: the virtual underlying asset users are trading for, such as vETH, vBTC
      2.1.2. Quote token: the counter currency of base token, which is always vUSDC for any base token
3. OrderBook -> (marketRegistry.address)
4. InsuranceFund -> (USDC.address)
5. Exchange -> (
		marketRegistry.address, 
		orderBook.address,
		clearingHouseConfig.address
	)
6. AccountBalance -> (clearingHouseConfig.address, orderbook.address)
7. Vault -> (
		insuranceFund.address,
    clearingHouseConfig.address,
    accountBalance.address,
    exchange.address,
   )
8. CollateralManager -> (
		clearingHouseConfig.address,
    vault.address,
    5, // maxCollateralTokensPerAccount
    "750000", // debtNonSettlementTokenValueRatio
    "500000", // liquidationRatio
    "2000", // mmRatioBuffer
    "30000", // clInsuranceFundFeeRatio
    parseUnits("10000", usdcDecimals), // debtThreshold
    parseUnits("500", usdcDecimals), // collateralValueDust
	)
9.  ClearingHouse -> (
			clearingHouseConfig.address,
      vault.address,
      quoteToken.address,
      uniV3Factory.address,
      exchange.address,
      accountBalance.address,
      insuranceFund.address
	)