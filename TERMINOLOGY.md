### A

- `AccountValue`: How much your account is worth (in USDC). It includes your collateral plus the PnL of every pool.
- `AccountMarginRatio`: Determined by AccountValue; you will be liquidated if AccountMarginRatio is lower than AccountMinMarginRatio
- `AccountMinMarginRatio`: Minimum margin ratio allowed for an account before it is liquidated; determined by mmRatio and positionValue of each market

---

### B

- `Broker`: Aka Uniswap V3 broker, if there is more broker in the future, then we will need to rename it to more explicit.

---

### C

- `Collateral`: The fund (USDC) to secure your positions in the exchange (dominated in USDC), same as margin in V1. Follow the naming of FTX.
- `CostBasis`: How much USDC you have
    - (1) borrowed (represented in negative values) for opening a long position, or
    - (2) received (represented in positive values) for opening a short position; it is used in combination with PositionValue to calculate your PnL

---

### F

- `FreeCollateral`: Your buying power, i.e. how much remaining collateral you have left for opening new positions. Once you have opened positions or limit orders, a portion of your collateral would be locked in order to secure those opened positions; the rest are free and hence the name.
- `FeeGrowthInsideLast`: cumulative fee per liquidity

---

### I

- `InitialMaintenanceRequirement`:  Minimum funds (USDC) required to open any new position or limit order. It is defined per market by `imRatio` and your current position & order values. If your account value is lower than it, you cannot open new positions or post new limit orders, but since your margin ratio could be still higher than `mmRatio` (because `imRatio > mmRatio`), your existing position might not be liquidated yet.
- `imReq`: `initialMaintenanceRequirement` for short.
- `imRatio`: Initial maintenance requirement ratio. For example, `imRatio = 10%` means you can open a position with a maximum of 10x leverage (`PositionValue` is 10 times larger than your `AccountValue`)

---

### **K**

- `Keeper`: Software bot that execute smart contract functions. Blockchains like Ethereum are passive and they cannot perform or schedule tasks themselves, so external actors such as keepers are needed. See examples and status in our [dashboard for keepers](https://detooperp.grafana.net/d/IX2rCvYMk/keepers-production?orgId=1&refresh=1m).

---

### L

- `LuShan`: The action code of the PERP v2 project, aka `鹿山`, is the top 100 mountains of Taiwan.

---

### M

- `Maker`: Those who make limit orders, equal to Liquidity Provider in an AMM such as an Uniswap pool.
- `Margin`: In our project, the margin is equal to collateral, but we DO NOT use this term in our code base so that it matches FTX's specs.
- `Market`: A market for a specific token pair (ex. ETH-USDC). Same as Pair.
- `Mint`: Follow the term from UniswapV3, it means add liquidity in LuShan.
- `MinimumMaintenanceRequirement`: Minimum funds (USDC) required for a position to not getting liquidated. It is defined by `mmRatio` and `PositionValue`
- `mmReq`: `MinimumMaintenanceRequirement` for short.
- `mmRatio`:  Minimum maintenance requirement ratio. For example, `mmRatio = 6.25%` means your position can have a maximum of 16x leverage (`PositionValue` is 16 times larger than your `AccountValue`) before getting liquidated.

---

### N

- 

---

### P

- `Pair`: for example, ETH/USDC, BTC/USDC called a pair
- `Pool`: Aka Uniswap V3 pool, in our Lushan project, it is equal to "market" or "pair" with "fee" concept. Fee is one of the values from the list [0.05, 0.3, 1]%.
- `Position`: A trader's position in a specific `Market` (ex. ETH-USDC). It could be a long position if the trader borrows USDC to buy ETH; or it could be a short position if the trader borrows ETH to trade for USDC. When a trader close her long position, she sells her ETH and repay her USDC debt; on the contrary, when she close her short position, she trade her USDC to buy back ETH repay her ETH debt.
- `PositionSize`: Position size in terms of how many perpetual-contracts. In our system, one perpetual-contract means one underlying token (ex. 1 ETH perpetual-contract represents 1 ETH worth of value)
- `PositionValue`: Position's value denominated in USD, same as position notional in V1

---

### T

- `Taker`: Same as trader in V1.
- `Token`: Aka ERC20 token, it is not equal to "asset", an asset is more general, if we support something like NFT in the future, then we can use "asset" in our code base instead.
- `Tick`: A specific price range (ex. 1.0001 ~ 1.0002). In UniswapV3 a tick is the unit/minimum of price range you can provide liquidity to. The unit/minimum of price range has been defined by UniswapV3, the price range will depend on the index of the ticks.
You can read more in [this article (2.Tick)](https://medium.com/taipei-ethereum-meetup/uniswap-v3-features-explained-in-depth-178cfe45f223).
- `TickSpace`: The size of the unit/minimum price range. It could be 0.0001 or larger based on which fee tier this UniswapV3 pool belongs. [Read more in the UniswapV3 ticks section.](https://docs.uniswap.org/concepts/V3-overview/concentrated-liquidity#ticks).

---

### V

- `vBase`: Virtual token for the underlying asset (ex. ETH). The virtual token alone does not have value.
- `vBaseDebt`:
- `vBaseDebtValue`: vBaseDebt * index price of vBase
- `vQuote`:
- `vQuoteDebt`:
- `vQuoteDebtVaelue` : vQuoteDebt * index price of vQuote
