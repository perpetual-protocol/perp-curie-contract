// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

interface IClearingHouse {
    struct AddLiquidityParams {
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
        uint256 minBase;
        uint256 minQuote;
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

    struct OpenPositionParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        // B2Q + exact input, want more output quote as possible, so we set a lower bound of output quote
        // B2Q + exact output, want less input base as possible, so we set a upper bound of input base
        // Q2B + exact input, want more output base as possible, so we set a lower bound of output base
        // Q2B + exact output, want less input quote as possible, so we set a upper bound of input quote
        // when it's set to 0, it will disable slippage protection entirely regardless of exact input or output
        // when it's over or under the bound, it will be reverted
        uint256 oppositeAmountBound;
        uint256 deadline;
        // B2Q: the price cannot be less than this value after the swap
        // Q2B: The price cannot be greater than this value after the swap
        // it will fill the trade until it reach the price limit instead of reverted
        // when it's set to 0, it will disable price limit entirely regardless of B2Q or Q2B
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

    event ReferredPositionChanged(bytes32 indexed referralCode);

    event PositionLiquidated(
        address indexed trader,
        address indexed baseToken,
        uint256 positionNotional,
        uint256 positionSize,
        uint256 liquidationFee,
        address liquidator
    );

    event FundingUpdated(address indexed baseToken, uint256 markTwap, uint256 indexTwap);

    event TrustedForwarderChanged(address indexed forwarder);

    function addLiquidity(AddLiquidityParams calldata params) external returns (AddLiquidityResponse memory);

    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        returns (RemoveLiquidityResponse memory response);

    function openPosition(OpenPositionParams memory params) external returns (uint256 deltaBase, uint256 deltaQuote);

    function closePosition(ClosePositionParams calldata params)
        external
        returns (uint256 deltaBase, uint256 deltaQuote);

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
}
