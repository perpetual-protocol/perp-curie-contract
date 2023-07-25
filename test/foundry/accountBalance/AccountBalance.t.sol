pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import "../../../contracts/interface/IIndexPrice.sol";
import "../../../contracts/interface/IBaseToken.sol";
import "../interface/IAccountBalanceEvent.sol";
import { IUniswapV3PoolState } from "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolState.sol";
import { IUniswapV3PoolDerivedState } from "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolDerivedState.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";

contract AccountBalanceTest is IAccountBalanceEvent, Setup {
    using SafeMathUpgradeable for uint256;

    function setUp() public virtual override {
        Setup.setUp();

        // initial market
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        marketRegistry.addPool(address(baseToken), pool.fee());

        // wait for 30 mins for TWAP
        skip(1800);
    }

    function test_getMarkPrice_should_return_index_price_with_premium_if_mark_price_enabled() public {
        (uint32 marketTwapInterval, uint32 premiumInterval) = clearingHouseConfig.getMarkPriceConfig();

        // mock market twap(15sec): price = 100, tick = 46080
        _mockMarketTwap(address(pool), 15, 46080);

        // mock market twap(30min): price = 95, tick = 45541
        _mockMarketTwap(address(pool), marketTwapInterval, 45541);

        // mock moving average: index + premium(15min), price = 97
        // 100 + (-3) = 97
        // mock index price: 100
        _mockIndexTwap(address(baseToken), 0, 100 * (10**18));

        // mock market twap(15m): price = 95, tick = 45541
        _mockMarketTwap(address(pool), premiumInterval, 45541);

        // mock index twap(15m), price = 98
        _mockIndexTwap(address(baseToken), premiumInterval, 98 * (10**18));

        uint256 result = accountBalance.getMarkPrice(address(baseToken));
        // median[100, 95, 97] = 97
        assertApproxEqAbs(result, 97 * (10**18), 10**15); // result should be 97 +/- 0.001, due to tick math
    }

    function _mockIndexTwap(
        address baseToken,
        uint32 interval,
        uint256 price
    ) internal {
        vm.mockCall(baseToken, abi.encodeWithSelector(IIndexPrice.getIndexPrice.selector, interval), abi.encode(price));
    }

    function _mockMarketPrice(address pool, uint256 sqrtPrice) internal {
        uint160 sqrtPriceX96 = _toUint160(sqrtPrice.mul(FixedPoint96.Q96));
        vm.mockCall(
            pool,
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(sqrtPriceX96, 0, 0, 0, 0, 0, false)
        );
    }

    function _mockMarketTwap(
        address pool,
        uint32 interval,
        int56 tick
    ) internal {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = interval;
        secondsAgos[1] = 0;

        // Ex: interval = 30m, tick = 95
        // Price: |---- 95 (10min)---|---- 95 (10min)---|---- 95 (10min)----|
        // Tick:  |-- 45541 (10min)--|-- 45541 (10min)--|-- 45541 (10min) --|

        int56[] memory tickCumulatives = new int56[](2);
        tickCumulatives[0] = 0;
        tickCumulatives[1] = tick * interval;

        uint160[] memory secondsPerLiquidityCumulativeX128s = new uint160[](2); // dummy

        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolDerivedState.observe.selector, secondsAgos),
            abi.encode(tickCumulatives, secondsPerLiquidityCumulativeX128s)
        );
    }

    function _toUint160(uint256 value) internal pure returns (uint160 returnValue) {
        require(((returnValue = uint160(value)) == value), "SafeCast: value doesn't fit in 160 bits");
    }
}
