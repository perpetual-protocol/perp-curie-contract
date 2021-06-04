pragma solidity 0.8.4;
pragma abicoder v2;

interface IClearingHouse {
    enum Side { BUY, SELL }

    struct Asset {
        uint256 balance;
        uint256 debt;
        uint256 fee;
    }

    struct OpenOrder {
        uint256 liquidity;
        uint24 tickLower;
        uint24 tickUpper;
        uint128 feeGrowthInsideLastBaseX128;
        uint128 feeGrowthInsideLastQuoteX128;
    }

    struct Account {
        uint256 margin;
        // key: vToken
        mapping(address => Asset) assetMap;
        // key: vToken, value: UniV3 pool
        mapping(address => address[]) tokenPoolsMap;
        // maker only
        address[] pools;
        // key: pool address, value: array of order ids
        mapping(address => uint256[]) makerPositionMap;
    }

    function deposit(uint256 _amount) external;

    // trader's function
    function removeMargin(uint256 _margin) external;

    function openPosition(
        address _pool,
        Side _side,
        uint256 _quote,
        uint256 baseLimit
    ) external returns (uint256 base);

    function closePosition(address _pool, uint256 _quoteLimit) external returns (uint256 quote, uint256 base);

    function liquidate(address _pool, address _taker) external returns (uint256 base);

    // maker's function
    function mint(address _asset, uint256 _amount) external;

    function burn(address _asset, uint256 _amount) external;

    function addLiquidity(
        address _pool,
        uint256 _base,
        uint256 _minBase,
        uint256 _quote,
        uint256 _minQuote,
        uint256 _tickLower,
        uint256 _tickUpper
    )
        external
        returns (
            uint256 liquidity,
            uint256 baseDelta,
            uint256 quoteDelta
        );

    function removeLiquidity(
        address _pool,
        uint256 _orderId,
        uint256 _liquidity
    )
        external
        returns (
            uint256 liquidity,
            uint256 baseDelta,
            uint256 quoteDelta,
            uint256 pnl
        );

    function cancelExcessOpenOrder(
        address _pool,
        address _maker,
        uint256 _orderId,
        uint256 _liquidity
    ) external;

    function collect(address _pool, uint256 _orderId) external returns (uint256 feeBase, uint256 feeQuote);
}
