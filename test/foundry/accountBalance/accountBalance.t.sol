pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "../helper/Setup.sol";
import "../../../contracts/interface/IIndexPrice.sol";
import { IUniswapV3PoolState } from "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolState.sol";
import { IUniswapV3PoolDerivedState } from "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolDerivedState.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";

contract AccountBalanceTest is Setup {
    using SafeMathUpgradeable for uint256;

    uint32 internal constant _marketTwapInterval = 30 minutes;
    uint32 internal constant _movingAverageInterval = 15 minutes;

    function setUp() public virtual override {
        Setup.setUp();

        // initial market
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        marketRegistry.addPool(address(baseToken), pool.fee());
    }

    // TODO: test setter

    function test_getMarkPrice_should_return_index_twap_if_marketRegistry_not_set() public {
        uint32 indexTwapInterval = clearingHouseConfig.getTwapInterval();
        // mock index twap
        uint256 indexTwap = 100;
        vm.mockCall(
            address(baseToken),
            abi.encodeWithSelector(IIndexPrice.getIndexPrice.selector, indexTwapInterval),
            abi.encode(indexTwap)
        );
        assertEq(accountBalance.getMarkPrice(address(baseToken)), indexTwap);
    }

    function test_getMarkPrice_should_return_moving_average_price_if_marketRegistry_is_set() public {
        accountBalance.setMarketRegistry(address(marketRegistry));

        // TODO: refactor mock code statements

        // mock current market price, price = 100
        uint256 sqrtPrice = 10;
        uint160 sqrtPriceX96 = _toUint160(sqrtPrice.mul(FixedPoint96.Q96));
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(sqrtPriceX96, 0, 0, 0, 0, 0, false)
        );

        // mock market twap(30min): price = 95
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = _marketTwapInterval;
        secondsAgos[1] = 0;

        // Price: |---- 90 (10min)---|---- 95 (10min)---|---- 100 (10min)---|
        // Tick:  |-- 45000 (10min)--|-- 45541 (10min)--|-- 46054 (10min) --|
        int56[] memory tickCumulatives = new int56[](2);
        tickCumulatives[0] = 0;
        tickCumulatives[1] = 81957000;

        uint160[] memory secondsPerLiquidityCumulativeX128s = new uint160[](2); // dummy

        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolDerivedState.observe.selector, secondsAgos),
            abi.encode(tickCumulatives, secondsPerLiquidityCumulativeX128s)
        );

        // mock moving average: index + premium(15min), price = 97
        // 100 + (-3) = 97
        vm.mockCall(
            address(baseToken),
            abi.encodeWithSelector(IIndexPrice.getIndexPrice.selector, 0),
            abi.encode(100 * (10**18))
        );

        // mock market twap(15m): price = 95
        uint32[] memory secondsAgos2 = new uint32[](2);
        secondsAgos2[0] = _movingAverageInterval;
        secondsAgos2[1] = 0;

        // Price: |---- 90 (5min)---|---- 95 (5min)---|---- 100 (5min)---|
        // Tick:  |-- 45000 (5min)--|-- 45541 (5min)--|-- 46054 (5min) --|
        int56[] memory tickCumulatives2 = new int56[](2);
        tickCumulatives2[0] = 0;
        tickCumulatives2[1] = 40978500;

        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolDerivedState.observe.selector, secondsAgos2),
            abi.encode(tickCumulatives2, secondsPerLiquidityCumulativeX128s)
        );

        // mock index twap(15m), price = 98
        vm.mockCall(
            address(baseToken),
            abi.encodeWithSelector(IIndexPrice.getIndexPrice.selector, _movingAverageInterval),
            abi.encode(98 * (10**18))
        );

        uint256 result = accountBalance.getMarkPrice(address(baseToken));
        assertApproxEqAbs(result, 97 * (10**18), 10**17); // result should be 97 +/- 0.1, due to tick math
    }

    function _toUint160(uint256 value) internal pure returns (uint160 returnValue) {
        require(((returnValue = uint160(value)) == value), "SafeCast: value doesn't fit in 160 bits");
    }
}
