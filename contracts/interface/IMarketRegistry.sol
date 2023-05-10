// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

interface IMarketRegistry {
    struct MarketInfo {
        address pool;
        uint24 exchangeFeeRatio;
        uint24 uniswapFeeRatio;
        uint24 insuranceFundFeeRatio;
        uint24 maxPriceSpreadRatio;
    }

    /// @notice Emitted when a new market is created.
    /// @param baseToken The address of the base token
    /// @param feeRatio Fee ratio of the market
    /// @param pool The address of the pool
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);

    /// @notice Emitted when the fee ratio of a market is updated.
    /// @param baseToken The address of the base token
    /// @param feeRatio Fee ratio of the market
    event FeeRatioChanged(address baseToken, uint24 feeRatio);

    /// @notice Emitted when the insurance fund fee ratio is updated.
    /// @param baseToken The address of the base token
    /// @param feeRatio Insurance fund fee ratio
    event InsuranceFundFeeRatioChanged(address baseToken, uint24 feeRatio);

    /// @notice Emitted when the max orders per market is updated.
    /// @param maxOrdersPerMarket Max orders per market
    event MaxOrdersPerMarketChanged(uint8 maxOrdersPerMarket);

    /// @notice Emitted when the max market price spread ratio is updated.
    /// @param baseToken The address of the base token
    /// @param spreadRatio Max market price spread ratio
    event MarketMaxPriceSpreadRatioChanged(address indexed baseToken, uint24 spreadRatio);

    /// @notice Emitted when the trader's fee discount ratio gets updated.
    /// @param trader The address of the trader
    /// @param discountRatio Fee discount ratio (percent-off)
    event FeeDiscountRatioChanged(address indexed trader, uint24 discountRatio);

    /// @notice Get the pool address (UNIv3 pool) by given base token address
    /// @param baseToken The address of the base token
    /// @return pool The address of the pool
    function getPool(address baseToken) external view returns (address pool);

    /// @notice Get the fee ratio of a given market
    /// @dev The ratio is in `1e6` format, that means `1% = 1e4`
    /// @param baseToken The address of the base token
    /// @return feeRatio The fee ratio of the market, it is a decimal in `1e6`
    function getFeeRatio(address baseToken) external view returns (uint24 feeRatio);

    /// @notice Get the insurance fund fee ratio of a given market
    /// @dev The ratio is in `1e6` format, that means `1% = 1e4`
    /// @param baseToken The address of the base token
    /// @return feeRatio The fee ratio of the market, it is a decimal in `1e6`
    function getInsuranceFundFeeRatio(address baseToken) external view returns (uint24 feeRatio);

    /// @notice Get the market info by given base token address
    /// @param baseToken The address of the base token
    /// @return info The market info encoded as `MarketInfo`
    function getMarketInfo(address baseToken) external view returns (MarketInfo memory info);

    /// @notice Get the market info by given trader address and base token address
    /// @param trader The address of the trader
    /// @param baseToken The address of the base token
    /// @return info The market info encoded as `MarketInfo`
    function getMarketInfoByTrader(address trader, address baseToken) external view returns (MarketInfo memory info);

    /// @notice Get the quote token address
    /// @return quoteToken The address of the quote token
    function getQuoteToken() external view returns (address quoteToken);

    /// @notice Get Uniswap factory address
    /// @return factory The address of the Uniswap factory
    function getUniswapV3Factory() external view returns (address factory);

    /// @notice Get max allowed orders per market
    /// @return maxOrdersPerMarket The max allowed orders per market
    function getMaxOrdersPerMarket() external view returns (uint8 maxOrdersPerMarket);

    /// @notice Check if a pool exist by given base token address
    /// @return hasPool True if the pool exist, false otherwise
    function hasPool(address baseToken) external view returns (bool hasPool);

    /// @return marketMaxPriceSpreadRatio Max price spread ratio of the market
    function getMarketMaxPriceSpreadRatio(address baseToken) external view returns (uint24 marketMaxPriceSpreadRatio);
}
