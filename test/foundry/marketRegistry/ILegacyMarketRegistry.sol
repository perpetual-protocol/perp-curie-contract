pragma solidity 0.7.6;
pragma abicoder v2;

// this interface is to test backward compatibility of marketRegistry
interface ILegacyMarketRegistry {
    struct LegacyMarketInfo {
        address pool;
        uint24 exchangeFeeRatio;
        uint24 uniswapFeeRatio;
        uint24 insuranceFundFeeRatio;
        // ignore maxPriceSpreadRatio field
    }

    function getMarketInfo(address baseToken) external view returns (LegacyMarketInfo memory info);
}
