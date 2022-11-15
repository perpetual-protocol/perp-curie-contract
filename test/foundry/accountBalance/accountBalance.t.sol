pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import "../../../contracts/interface/IIndexPrice.sol";

contract AccountBalanceTest is Setup {
    function setUp() public virtual override {
        Setup.setUp();
    }

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
}
