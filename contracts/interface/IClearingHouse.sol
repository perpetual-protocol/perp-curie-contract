// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

interface IClearingHouse {
    /// @param useTakerBalance only accept false now
    struct AddLiquidityParams {
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
        uint256 minBase;
        uint256 minQuote;
        bool useTakerBalance;
        uint256 deadline;
    }

    /// @param liquidity collect fee when 0
    struct RemoveLiquidityParams {
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
        uint256 minBase;
        uint256 minQuote;
        uint256 deadline;
    }

    struct AddLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
        uint256 liquidity;
    }

    struct RemoveLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
    }

    /// @param oppositeAmountBound
    // B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote
    // B2Q + exact output, want less input base as possible, so we set a upper bound of input base
    // Q2B + exact input, want more output base as possible, so we set a lower bound of output base
    // Q2B + exact output, want less input quote as possible, so we set a upper bound of input quote
    // when it's set to 0, it will disable slippage protection entirely regardless of exact input or output
    // when it's over or under the bound, it will be reverted
    /// @param sqrtPriceLimitX96
    // B2Q: the price cannot be less than this value after the swap
    // Q2B: the price cannot be greater than this value after the swap
    // it will fill the trade until it reaches the price limit but WON'T REVERT
    // when it's set to 0, it will disable price limit;
    // when it's 0 and exact output, the output amount is required to be identical to the param amount
    struct OpenPositionParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint256 oppositeAmountBound;
        uint256 deadline;
        uint160 sqrtPriceLimitX96;
        bytes32 referralCode;
    }

    struct ClosePositionParams {
        address baseToken;
        uint160 sqrtPriceLimitX96;
        uint256 oppositeAmountBound;
        uint256 deadline;
        bytes32 referralCode;
    }

    struct CollectPendingFeeParams {
        address trader;
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
    }

    /// @notice Emitted when open position with non-zero referral code
    /// @param referralCode The referral code by partners
    event ReferredPositionChanged(bytes32 indexed referralCode);

    /// @notice Emitted when taker position is being liquidated
    /// @param trader The trader who has been liquidated
    /// @param baseToken Virtual base token(ETH, BTC, etc...) address
    /// @param positionNotional The cost of position
    /// @param positionSize The size of position
    /// @param liquidationFee The fee of liquidate
    /// @param liquidator The address of liquidator
    event PositionLiquidated(
        address indexed trader,
        address indexed baseToken,
        uint256 positionNotional,
        uint256 positionSize,
        uint256 liquidationFee,
        address liquidator
    );

    /// @notice Emitted when maker's liquidity of a order changed
    /// @param maker The one who provide liquidity
    /// @param baseToken The address of virtual base token(ETH, BTC, etc...)
    /// @param quoteToken The address of virtual USD token
    /// @param lowerTick The lower tick of the position in which to add liquidity
    /// @param upperTick The upper tick of the position in which to add liquidity
    /// @param base The amount of base token added (> 0) / removed (< 0) as liquidity; fees not included
    /// @param quote The amount of quote token added ... (same as the above)
    /// @param liquidity The amount of liquidity unit added (> 0) / removed (< 0)
    /// @param quoteFee The amount of quote token the maker received as fees
    event LiquidityChanged(
        address indexed maker,
        address indexed baseToken,
        address indexed quoteToken,
        int24 lowerTick,
        int24 upperTick,
        int256 base,
        int256 quote,
        int128 liquidity,
        uint256 quoteFee
    );

    /// @notice Emitted when taker's position is being changed
    /// @param trader Trader address
    /// @param baseToken The address of virtual base token(ETH, BTC, etc...)
    /// @param exchangedPositionSize The actual amount swap to uniswapV3 pool
    /// @param exchangedPositionNotional The cost of position, include fee
    /// @param fee The fee of open/close position
    /// @param openNotional The cost of open/close position, < 0: long, > 0: short
    /// @param realizedPnl The realized Pnl after open/close position
    /// @param sqrtPriceAfterX96 The sqrt price after swap, in X96
    event PositionChanged(
        address indexed trader,
        address indexed baseToken,
        int256 exchangedPositionSize,
        int256 exchangedPositionNotional,
        uint256 fee,
        int256 openNotional,
        int256 realizedPnl,
        uint256 sqrtPriceAfterX96
    );

    /// @notice Emitted when taker close her position in closed market
    /// @param trader Trader address
    /// @param baseToken The address of virtual base token(ETH, BTC, etc...)
    /// @param closedPositionSize Trader's position size in closed market
    /// @param closedPositionNotional Trader's position notional in closed market, based on closed price
    /// @param openNotional The cost of open/close position, < 0: long, > 0: short
    /// @param realizedPnl The realized Pnl after close position
    /// @param closedPrice The close price of position
    event PositionClosed(
        address indexed trader,
        address indexed baseToken,
        int256 closedPositionSize,
        int256 closedPositionNotional,
        int256 openNotional,
        int256 realizedPnl,
        uint256 closedPrice
    );

    /// @notice Emitted when settling a trader's funding payment
    /// @param trader The address of trader
    /// @param baseToken The address of virtual base token(ETH, BTC, etc...)
    /// @param fundingPayment The fundingPayment of trader on baseToken market, > 0: payment, < 0 : receipt
    event FundingPaymentSettled(address indexed trader, address indexed baseToken, int256 fundingPayment);

    /// @notice Emitted when trusted forwarder address changed
    /// @dev TrustedForward is only used for metaTx
    /// @param forwarder The trusted forwarder address
    event TrustedForwarderChanged(address indexed forwarder);

    /// @notice Emitted when DelegateApproval address changed
    /// @param delegateApproval The address of DelegateApproval
    event DelegateApprovalChanged(address indexed delegateApproval);

    /// @notice Maker can call `addLiquidity` to provide liquidity on Uniswap V3 pool
    /// @dev Tx will fail if adding `base == 0 && quote == 0` / `liquidity == 0`
    /// @dev - `AddLiquidityParams.useTakerBalance` is only accept `false` now
    /// @param params AddLiquidityParams struct
    /// @return response AddLiquidityResponse struct
    function addLiquidity(AddLiquidityParams calldata params) external returns (AddLiquidityResponse memory response);

    /// @notice Maker can call `removeLiquidity` to remove liquidity
    /// @dev remove liquidity will transfer maker impermanent position to taker position,
    /// if `liquidity` of RemoveLiquidityParams struct is zero, the action will collect fee from
    /// pool to maker
    /// @param params RemoveLiquidityParams struct
    /// @return response RemoveLiquidityResponse struct
    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        returns (RemoveLiquidityResponse memory response);

    /// @notice Settle all markets fundingPayment to owedRealized Pnl
    /// @param trader The address of trader
    function settleAllFunding(address trader) external;

    /// @notice Trader can call `openPosition` to long/short on baseToken market
    /// @dev - `OpenPositionParams.oppositeAmountBound`
    ///     - B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote
    ///     - B2Q + exact output, want less input base as possible, so we set a upper bound of input base
    ///     - Q2B + exact input, want more output base as possible, so we set a lower bound of output base
    ///     - Q2B + exact output, want less input quote as possible, so we set a upper bound of input quote
    ///     > when it's set to 0, it will disable slippage protection entirely regardless of exact input or output
    ///     > when it's over or under the bound, it will be reverted
    /// @dev - `OpenPositionParams.sqrtPriceLimitX96`
    ///     - B2Q: the price cannot be less than this value after the swap
    ///     - Q2B: the price cannot be greater than this value after the swap
    ///     > it will fill the trade until it reaches the price limit but WON'T REVERT
    ///     > when it's set to 0, it will disable price limit;
    ///     > when it's 0 and exact output, the output amount is required to be identical to the param amount
    /// @param params OpenPositionParams struct
    /// @return base The amount of baseToken the taker got or spent
    /// @return quote The amount of quoteToken the taker got or spent
    function openPosition(OpenPositionParams memory params) external returns (uint256 base, uint256 quote);

    /// @param trader The address of trader
    /// @param params OpenPositionParams struct is the same as `openPosition()`
    /// @return base The amount of baseToken the taker got or spent
    /// @return quote The amount of quoteToken the taker got or spent
    /// @return fee The trading fee
    function openPositionFor(address trader, OpenPositionParams memory params)
        external
        returns (
            uint256 base,
            uint256 quote,
            uint256 fee
        );

    /// @notice Close trader's position
    /// @param params ClosePositionParams struct
    /// @return base The amount of baseToken the taker got or spent
    /// @return quote The amount of quoteToken the taker got or spent
    function closePosition(ClosePositionParams calldata params) external returns (uint256 base, uint256 quote);

    /// @notice If trader is underwater, any one can call `liquidate` to liquidate this trader
    /// @dev If trader has open orders, need to call `cancelAllExcessOrders` first
    /// @dev If positionSize is greater than maxLiquidatePositionSize, liquidate maxLiquidatePositionSize by default
    /// @dev If margin ratio >= 0.5 * mmRatio,
    ///         maxLiquidateRatio = MIN((1, 0.5 * totalAbsPositionValue / absPositionValue)
    /// @dev If margin ratio < 0.5 * mmRatio, maxLiquidateRatio = 1
    /// @dev maxLiquidatePositionSize = positionSize * maxLiquidateRatio
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @param positionSize the position size to be liquidated by liquidator
    //    and MUST be the same direction as trader's position size
    function liquidate(
        address trader,
        address baseToken,
        int256 positionSize
    ) external;

    /// @notice liquidate trader's position and will liquidate the max possible position size
    /// @dev If margin ratio >= 0.5 * mmRatio,
    ///         maxLiquidateRatio = MIN((1, 0.5 * totalAbsPositionValue / absPositionValue)
    /// @dev If margin ratio < 0.5 * mmRatio, maxLiquidateRatio = 1
    /// @dev maxLiquidatePositionSize = positionSize * maxLiquidateRatio
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    function liquidate(address trader, address baseToken) external;

    /// @notice Cancel excess order of a maker
    /// @dev Order id can get from `OrderBook.getOpenOrderIds`
    /// @param maker The address of Maker
    /// @param baseToken The address of baseToken
    /// @param orderIds The id of the order
    function cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external;

    /// @notice Cancel all excess orders of a maker if the maker is underwater
    /// @dev This function won't fail if the maker has no order but fails when maker is not underwater
    /// @param maker The address of maker
    /// @param baseToken The address of baseToken
    function cancelAllExcessOrders(address maker, address baseToken) external;

    /// @notice Close all positions and remove all liquidities of a trader in the closed market
    /// @param trader The address of trader
    /// @param baseToken The address of baseToken
    /// @return base The amount of base token that is closed
    /// @return quote The amount of quote token that is closed
    function quitMarket(address trader, address baseToken) external returns (uint256 base, uint256 quote);

    /// @notice Get account value of trader
    /// @dev accountValue = totalCollateralValue + totalUnrealizedPnl, in 18 decimals
    /// @param trader The address of trader
    /// @return accountValue The account value of trader
    function getAccountValue(address trader) external view returns (int256 accountValue);

    /// @notice Get QuoteToken address
    /// @return quoteToken The quote token address
    function getQuoteToken() external view returns (address quoteToken);

    /// @notice Get UniswapV3Factory address
    /// @return factory UniswapV3Factory address
    function getUniswapV3Factory() external view returns (address factory);

    /// @notice Get ClearingHouseConfig address
    /// @return clearingHouseConfig ClearingHouseConfig address
    function getClearingHouseConfig() external view returns (address clearingHouseConfig);

    /// @notice Get `Vault` address
    /// @return vault `Vault` address
    function getVault() external view returns (address vault);

    /// @notice Get `Exchange` address
    /// @return exchange `Exchange` address
    function getExchange() external view returns (address exchange);

    /// @notice Get `OrderBook` address
    /// @return orderBook `OrderBook` address
    function getOrderBook() external view returns (address orderBook);

    /// @notice Get AccountBalance address
    /// @return accountBalance `AccountBalance` address
    function getAccountBalance() external view returns (address accountBalance);

    /// @notice Get `InsuranceFund` address
    /// @return insuranceFund `InsuranceFund` address
    function getInsuranceFund() external view returns (address insuranceFund);

    /// @notice Get `DelegateApproval` address
    /// @return delegateApproval `DelegateApproval` address
    function getDelegateApproval() external view returns (address delegateApproval);
}
