// SPDX-License-Identifier: GPL-2.0-or-later
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

    event ReferredPositionChanged(bytes32 indexed referralCode);

    event PositionLiquidated(
        address indexed trader,
        address indexed baseToken,
        uint256 positionNotional,
        uint256 positionSize,
        uint256 liquidationFee,
        address liquidator
    );

    /// @param base the amount of base token added (> 0) / removed (< 0) as liquidity; fees not included
    /// @param quote the amount of quote token added ... (same as the above)
    /// @param liquidity the amount of liquidity unit added (> 0) / removed (< 0)
    /// @param quoteFee the amount of quote token the maker received as fees
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

    /// @param fundingPayment > 0: payment, < 0 : receipt
    event FundingPaymentSettled(address indexed trader, address indexed baseToken, int256 fundingPayment);

    event TrustedForwarderChanged(address indexed forwarder);

    /// @dev tx will fail if adding base == 0 && quote == 0 / liquidity == 0
    function addLiquidity(AddLiquidityParams calldata params) external returns (AddLiquidityResponse memory);

    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        returns (RemoveLiquidityResponse memory response);

    function settleAllFunding(address trader) external;

    function openPosition(OpenPositionParams memory params) external returns (uint256 base, uint256 quote);

    function closePosition(ClosePositionParams calldata params) external returns (uint256 base, uint256 quote);

    function liquidate(
        address trader,
        address baseToken,
        uint256 oppositeAmountBound
    )
        external
        returns (
            uint256 base,
            uint256 quote,
            bool isPartialClose
        );

    /// @dev This function will be deprecated in the future, recommend to use the above one liquidate
    function liquidate(address trader, address baseToken) external;

    function cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external;

    function cancelAllExcessOrders(address maker, address baseToken) external;

    /// @dev accountValue = totalCollateralValue + totalUnrealizedPnl, in 18 decimals
    function getAccountValue(address trader) external view returns (int256);

    function getQuoteToken() external view returns (address);

    function getUniswapV3Factory() external view returns (address);

    function getClearingHouseConfig() external view returns (address);

    function getVault() external view returns (address);

    function getExchange() external view returns (address);

    function getOrderBook() external view returns (address);

    function getAccountBalance() external view returns (address);

    function getInsuranceFund() external view returns (address);
}
